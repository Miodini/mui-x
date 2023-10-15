import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {
  unstable_useForkRef as useForkRef,
  unstable_useEnhancedEffect as useEnhancedEffect,
  unstable_useEventCallback as useEventCallback,
} from '@mui/utils';
import { useTheme } from '@mui/material/styles';
import { defaultMemoize } from 'reselect';
import { useGridPrivateApiContext } from '../../utils/useGridPrivateApiContext';
import { useGridRootProps } from '../../utils/useGridRootProps';
import { useGridSelector } from '../../utils/useGridSelector';
import { useLazyRef } from '../../utils/useLazyRef';
import {
  gridVisibleColumnDefinitionsSelector,
  gridColumnsTotalWidthSelector,
  gridColumnPositionsSelector,
} from '../columns/gridColumnsSelector';
import { gridFocusCellSelector, gridTabIndexCellSelector } from '../focus/gridFocusStateSelector';
import { useGridVisibleRows } from '../../utils/useGridVisibleRows';
import { clamp } from '../../../utils/utils';
import { GridRenderContext, GridRowEntry } from '../../../models';
import { selectedIdsLookupSelector } from '../rowSelection/gridRowSelectionSelector';
import { gridRowsMetaSelector } from '../rows/gridRowsMetaSelector';
import { GridRowId, GridRowModel } from '../../../models/gridRows';
import { GridStateColDef } from '../../../models/colDef/gridColDef';
import { getFirstNonSpannedColumnToRender } from '../columns/gridColumnsUtils';
import { getMinimalContentHeight } from '../rows/gridRowsUtils';
import { GridRowProps } from '../../../components/GridRow';
import {
  gridVirtualizationEnabledSelector,
  gridVirtualizationColumnEnabledSelector,
} from './gridVirtualizationSelectors';

// Uses binary search to avoid looping through all possible positions
export function binarySearch(
  offset: number,
  positions: number[],
  sliceStart = 0,
  sliceEnd = positions.length,
): number {
  if (positions.length <= 0) {
    return -1;
  }

  if (sliceStart >= sliceEnd) {
    return sliceStart;
  }

  const pivot = sliceStart + Math.floor((sliceEnd - sliceStart) / 2);
  const itemOffset = positions[pivot];
  return offset <= itemOffset
    ? binarySearch(offset, positions, sliceStart, pivot)
    : binarySearch(offset, positions, pivot + 1, sliceEnd);
}

function exponentialSearch(offset: number, positions: number[], index: number): number {
  let interval = 1;

  while (index < positions.length && Math.abs(positions[index]) < offset) {
    index += interval;
    interval *= 2;
  }

  return binarySearch(offset, positions, Math.floor(index / 2), Math.min(index, positions.length));
}

export const getIndexesToRender = ({
  firstIndex,
  lastIndex,
  buffer,
  minFirstIndex,
  maxLastIndex,
}: {
  firstIndex: number;
  lastIndex: number;
  buffer: number;
  minFirstIndex: number;
  maxLastIndex: number;
}) => {
  return [
    clamp(firstIndex - buffer, minFirstIndex, maxLastIndex),
    clamp(lastIndex + buffer, minFirstIndex, maxLastIndex),
  ];
};

export const areRenderContextsEqual = (
  context1: GridRenderContext,
  context2: GridRenderContext,
) => {
  if (context1 === context2) {
    return true;
  }
  return (
    context1.firstRowIndex === context2.firstRowIndex &&
    context1.lastRowIndex === context2.lastRowIndex &&
    context1.firstColumnIndex === context2.firstColumnIndex &&
    context1.lastColumnIndex === context2.lastColumnIndex
  );
};

interface UseGridVirtualScrollerProps {
  ref: React.Ref<HTMLDivElement>;
  onRenderZonePositioning?: (params: { top: number; left: number }) => void;
  getRowProps?: (id: GridRowId, model: GridRowModel) => any;
}

const EMPTY_RENDER_CONTEXT = {
  firstRowIndex: 0,
  lastRowIndex: 0,
  firstColumnIndex: 0,
  lastColumnIndex: 0,
};

export const EMPTY_PINNED_COLUMNS = {
  left: [] as GridStateColDef[],
  right: [] as GridStateColDef[],
};

export type VirtualScroller = ReturnType<typeof useGridVirtualScroller>;

export const useGridVirtualScroller = (props: UseGridVirtualScrollerProps) => {
  const apiRef = useGridPrivateApiContext();
  const rootProps = useGridRootProps();
  const visibleColumns = useGridSelector(apiRef, gridVisibleColumnDefinitionsSelector);
  const enabled = useGridSelector(apiRef, gridVirtualizationEnabledSelector);
  const enabledForColumns = useGridSelector(apiRef, gridVirtualizationColumnEnabledSelector);
  const dimensions = useGridSelector(apiRef, () => apiRef.current.getRootDimensions());
  const containerDimensions = dimensions.viewportOuterSize;
  const [visiblePinnedColumns, setVisiblePinnedColumns] = React.useState(EMPTY_PINNED_COLUMNS);

  const { ref, onRenderZonePositioning, getRowProps } = props;

  const theme = useTheme();
  const columnPositions = useGridSelector(apiRef, gridColumnPositionsSelector);
  const columnsTotalWidth = useGridSelector(apiRef, gridColumnsTotalWidthSelector);
  const cellFocus = useGridSelector(apiRef, gridFocusCellSelector);
  const cellTabIndex = useGridSelector(apiRef, gridTabIndexCellSelector);
  const rowsMeta = useGridSelector(apiRef, gridRowsMetaSelector);
  const selectedRowsLookup = useGridSelector(apiRef, selectedIdsLookupSelector);
  const currentPage = useGridVisibleRows(apiRef, rootProps);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const handleRef = useForkRef(ref, rootRef);
  const renderZoneRef = React.useRef<HTMLDivElement>(null);
  const gridRootRef = apiRef.current.rootElementRef!;

  const [renderContext, setRenderContext] = React.useState(EMPTY_RENDER_CONTEXT);
  const [realRenderContext, setRealRenderContext] = React.useState(EMPTY_RENDER_CONTEXT);
  const prevRenderContext = React.useRef(renderContext);
  const scrollPosition = React.useRef({ top: 0, left: 0 }).current;
  const prevTotalWidth = React.useRef(columnsTotalWidth);

  const rowStyleCache = React.useRef<Record<GridRowId, any>>(Object.create(null));
  const prevGetRowProps = React.useRef<UseGridVirtualScrollerProps['getRowProps']>();
  const prevRootRowStyle = React.useRef<GridRowProps['style']>();

  const getRenderedColumns = useLazyRef(createGetRenderedColumns).current;

  const getRenderContext = () => realRenderContext;

  const indexOfRowWithFocusedCell = React.useMemo<number>(() => {
    if (cellFocus !== null) {
      return currentPage.rows.findIndex((row) => row.id === cellFocus.id);
    }
    return -1;
  }, [cellFocus, currentPage.rows]);

  const indexOfColumnWithFocusedCell = React.useMemo<number>(() => {
    if (cellFocus !== null) {
      return visibleColumns.findIndex((column) => column.field === cellFocus.field);
    }
    return -1;
  }, [cellFocus, visibleColumns]);

  const getNearestIndexToRender = React.useCallback(
    (offset: number) => {
      const lastMeasuredIndexRelativeToAllRows = apiRef.current.getLastMeasuredRowIndex();
      let allRowsMeasured = lastMeasuredIndexRelativeToAllRows === Infinity;
      if (currentPage.range?.lastRowIndex && !allRowsMeasured) {
        // Check if all rows in this page are already measured
        allRowsMeasured = lastMeasuredIndexRelativeToAllRows >= currentPage.range.lastRowIndex;
      }

      const lastMeasuredIndexRelativeToCurrentPage = clamp(
        lastMeasuredIndexRelativeToAllRows - (currentPage.range?.firstRowIndex || 0),
        0,
        rowsMeta.positions.length,
      );

      if (allRowsMeasured || rowsMeta.positions[lastMeasuredIndexRelativeToCurrentPage] >= offset) {
        // If all rows were measured (when no row has "auto" as height) or all rows before the offset
        // were measured, then use a binary search because it's faster.
        return binarySearch(offset, rowsMeta.positions);
      }

      // Otherwise, use an exponential search.
      // If rows have "auto" as height, their positions will be based on estimated heights.
      // In this case, we can skip several steps until we find a position higher than the offset.
      // Inspired by https://github.com/bvaughn/react-virtualized/blob/master/source/Grid/utils/CellSizeAndPositionManager.js
      return exponentialSearch(offset, rowsMeta.positions, lastMeasuredIndexRelativeToCurrentPage);
    },
    [apiRef, currentPage.range?.firstRowIndex, currentPage.range?.lastRowIndex, rowsMeta.positions],
  );

  const computeRenderContext = React.useCallback(() => {
    if (!enabled) {
      return {
        firstRowIndex: 0,
        lastRowIndex: currentPage.rows.length,
        firstColumnIndex: 0,
        lastColumnIndex: visibleColumns.length,
      };
    }

    const { top, left } = scrollPosition;

    // Clamp the value because the search may return an index out of bounds.
    // In the last index, this is not needed because Array.slice doesn't include it.
    const firstRowIndex = Math.min(getNearestIndexToRender(top), rowsMeta.positions.length - 1);

    const lastRowIndex = rootProps.autoHeight
      ? firstRowIndex + currentPage.rows.length
      : getNearestIndexToRender(top + containerDimensions.height);

    let firstColumnIndex = 0;
    let lastColumnIndex = columnPositions.length;

    if (enabledForColumns) {
      let hasRowWithAutoHeight = false;

      const [firstRowToRender, lastRowToRender] = getIndexesToRender({
        firstIndex: firstRowIndex,
        lastIndex: lastRowIndex,
        minFirstIndex: 0,
        maxLastIndex: currentPage.rows.length,
        buffer: rootProps.rowBuffer,
      });

      for (let i = firstRowToRender; i < lastRowToRender && !hasRowWithAutoHeight; i += 1) {
        const row = currentPage.rows[i];
        hasRowWithAutoHeight = apiRef.current.rowHasAutoHeight(row.id);
      }

      if (!hasRowWithAutoHeight) {
        firstColumnIndex = binarySearch(Math.abs(left), columnPositions);
        lastColumnIndex = binarySearch(Math.abs(left) + containerDimensions.width, columnPositions);
      }
    }

    return {
      firstRowIndex,
      lastRowIndex,
      firstColumnIndex,
      lastColumnIndex,
    };
  }, [
    enabled,
    enabledForColumns,
    getNearestIndexToRender,
    rowsMeta.positions.length,
    rootProps.autoHeight,
    rootProps.rowBuffer,
    currentPage.rows,
    columnPositions,
    visibleColumns.length,
    apiRef,
    containerDimensions,
  ]);

  const computeRealRenderContext = React.useCallback(
    (nextRenderContext: GridRenderContext) => {
      const [firstRowToRender, lastRowToRender] = getIndexesToRender({
        firstIndex: nextRenderContext.firstRowIndex,
        lastIndex: nextRenderContext.lastRowIndex,
        minFirstIndex: 0,
        maxLastIndex: currentPage.rows.length,
        buffer: rootProps.rowBuffer,
      });

      const [initialFirstColumnToRender, lastColumnToRender] = getIndexesToRender({
        firstIndex: nextRenderContext.firstColumnIndex,
        lastIndex: nextRenderContext.lastColumnIndex,
        minFirstIndex: visiblePinnedColumns.left.length,
        maxLastIndex: visibleColumns.length - visiblePinnedColumns.right.length,
        buffer: rootProps.columnBuffer,
      });

      const firstColumnToRender = getFirstNonSpannedColumnToRender({
        firstColumnToRender: initialFirstColumnToRender,
        apiRef,
        firstRowToRender,
        lastRowToRender,
        visibleRows: currentPage.rows,
      });

      return {
        firstRowIndex: firstRowToRender,
        lastRowIndex: lastRowToRender,
        firstColumnIndex: firstColumnToRender,
        lastColumnIndex: lastColumnToRender,
      };
    },
    [visibleColumns.length, rootProps.rowBuffer, rootProps.columnBuffer, currentPage.rows],
  );

  const updateRenderZonePosition = React.useCallback(
    (nextRenderContext: GridRenderContext) => {
      const direction = theme.direction === 'ltr' ? 1 : -1;
      const columnPositions = gridColumnPositionsSelector(apiRef);

      const top = gridRowsMetaSelector(apiRef.current.state).positions[
        nextRenderContext.firstRowIndex
      ];
      const left = direction * columnPositions[nextRenderContext.firstColumnIndex] - columnPositions[visiblePinnedColumns.left.length];

      gridRootRef.current!.style.setProperty('--private_DataGrid-offsetTop', `${top}px`);
      gridRootRef.current!.style.setProperty('--private_DataGrid-offsetLeft', `${left}px`);

      onRenderZonePositioning?.({ top, left });
    },
    [apiRef, computeRealRenderContext, onRenderZonePositioning, theme.direction],
  );

  const updateRenderContext = React.useCallback(
    (nextRenderContext: GridRenderContext) => {
      if (areRenderContextsEqual(nextRenderContext, prevRenderContext.current)) {
        return;
      }

      const realRenderContext = computeRealRenderContext(nextRenderContext);

      setRenderContext(nextRenderContext);
      setRealRenderContext(realRenderContext);

      updateRenderZonePosition(realRenderContext);

      const didRowIntervalChange = 
        nextRenderContext.firstRowIndex !== prevRenderContext.current.firstRowIndex ||
        nextRenderContext.lastRowIndex !== prevRenderContext.current.lastRowIndex

      // The lazy-loading hook is listening to `renderedRowsIntervalChange`,
      // but only does something if the dimensions are also available.
      // So we wait until we have valid dimensions before publishing the first event.
      if (dimensions.isReady && didRowIntervalChange) {
        apiRef.current.publishEvent('renderedRowsIntervalChange', {
          firstRowToRender: realRenderContext.firstRowIndex,
          lastRowToRender: realRenderContext.lastRowIndex,
        });
      }

      prevRenderContext.current = nextRenderContext;
    },
    [
      apiRef,
      prevRenderContext,
      currentPage.rows.length,
      rootProps.rowBuffer,
      dimensions.isReady,
      updateRenderZonePosition,
    ],
  );

  const handleScroll = useEventCallback((event: React.UIEvent) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    scrollPosition.top = scrollTop;
    scrollPosition.left = scrollLeft;

    // On iOS and macOS, negative offsets are possible when swiping past the start
    if (!prevRenderContext.current || scrollTop < 0) {
      return;
    }
    if (theme.direction === 'ltr') {
      if (scrollLeft < 0) {
        return;
      }
    }
    if (theme.direction === 'rtl') {
      if (scrollLeft > 0) {
        return;
      }
    }

    // When virtualization is disabled, the context never changes during scroll
    const nextRenderContext = enabled ? computeRenderContext() : prevRenderContext.current;

    const topRowsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.firstRowIndex - prevRenderContext.current.firstRowIndex,
    );
    const bottomRowsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.lastRowIndex - prevRenderContext.current.lastRowIndex,
    );

    const topColumnsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.firstColumnIndex - prevRenderContext.current.firstColumnIndex,
    );
    const bottomColumnsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.lastColumnIndex - prevRenderContext.current.lastColumnIndex,
    );

    const shouldSetState =
      topRowsScrolledSincePreviousRender >= rootProps.rowThreshold ||
      bottomRowsScrolledSincePreviousRender >= rootProps.rowThreshold ||
      topColumnsScrolledSincePreviousRender >= rootProps.columnThreshold ||
      bottomColumnsScrolledSincePreviousRender >= rootProps.columnThreshold ||
      prevTotalWidth.current !== columnsTotalWidth;

    apiRef.current.publishEvent(
      'scrollPositionChange',
      {
        top: scrollTop,
        left: scrollLeft,
        renderContext: shouldSetState ? nextRenderContext : prevRenderContext.current,
      },
      event,
    );

    if (shouldSetState) {
      // Prevents batching render context changes
      ReactDOM.flushSync(() => {
        updateRenderContext(nextRenderContext);
      });
      prevTotalWidth.current = columnsTotalWidth;
    }
  });

  const handleWheel = useEventCallback((event: React.WheelEvent) => {
    apiRef.current.publishEvent('virtualScrollerWheel', {}, event);
  });

  const handleTouchMove = useEventCallback((event: React.TouchEvent) => {
    apiRef.current.publishEvent('virtualScrollerTouchMove', {}, event);
  });

  const minFirstColumn = visiblePinnedColumns.left.length;
  const maxLastColumn = visibleColumns.length - visiblePinnedColumns.right.length;
  const availableSpace = containerDimensions.width;

  const getRows = (
    params: {
      rows?: GridRowEntry[];
      rowIndexOffset?: number;
    } = {},
  ) => {
    const { rowIndexOffset = 0 } = params;

    if (availableSpace == null) {
      return [];
    }

    const firstRowToRender = realRenderContext.firstRowIndex;
    const lastRowToRender = realRenderContext.lastRowIndex;
    const firstColumnToRender = realRenderContext.firstColumnIndex;
    const lastColumnToRender = realRenderContext.lastColumnIndex;

    if (!params.rows && !currentPage.range) {
      return [];
    }

    const renderedRows = params.rows ?? currentPage.rows.slice(firstRowToRender, lastRowToRender);

    renderedRows.forEach((row) => {
      apiRef.current.calculateColSpan({
        rowId: row.id,
        minFirstColumn,
        maxLastColumn,
        columns: visibleColumns,
      });

      if (visiblePinnedColumns.left.length > 0) {
        apiRef.current.calculateColSpan({
          rowId: row.id,
          minFirstColumn: 0,
          maxLastColumn: visiblePinnedColumns.left.length,
          columns: visibleColumns,
        });
      }

      if (visiblePinnedColumns.right.length > 0) {
        apiRef.current.calculateColSpan({
          rowId: row.id,
          minFirstColumn: visibleColumns.length - visiblePinnedColumns.right.length,
          maxLastColumn: visibleColumns.length,
          columns: visibleColumns,
        });
      }
    });

    // If the selected row is not within the current range of rows being displayed,
    // we need to render it at either the top or bottom of the rows,
    // depending on whether it is above or below the range.
    let isRowWithFocusedCellNotInRange = false;
    if (indexOfRowWithFocusedCell > -1) {
      const rowWithFocusedCell = currentPage.rows[indexOfRowWithFocusedCell];
      if (
        firstRowToRender > indexOfRowWithFocusedCell ||
        lastRowToRender < indexOfRowWithFocusedCell
      ) {
        isRowWithFocusedCellNotInRange = true;
        if (indexOfRowWithFocusedCell > firstRowToRender) {
          renderedRows.push(rowWithFocusedCell);
        } else {
          renderedRows.unshift(rowWithFocusedCell);
        }
        apiRef.current.calculateColSpan({
          rowId: rowWithFocusedCell.id,
          minFirstColumn,
          maxLastColumn,
          columns: visibleColumns,
        });
      }
    }

    let isColumnWihFocusedCellNotInRange = false;
    if (
      firstColumnToRender > indexOfColumnWithFocusedCell ||
      lastColumnToRender < indexOfColumnWithFocusedCell
    ) {
      isColumnWihFocusedCellNotInRange = true;
    }

    const { focusedCellColumnIndexNotInRange, renderedColumns } = getRenderedColumns(
      visibleColumns,
      firstColumnToRender,
      lastColumnToRender,
      minFirstColumn,
      maxLastColumn,
      isColumnWihFocusedCellNotInRange ? indexOfColumnWithFocusedCell : -1,
    );

    const { style: rootRowStyle, ...rootRowProps } = rootProps.slotProps?.row || {};

    const invalidateCache =
      prevGetRowProps.current !== getRowProps || prevRootRowStyle.current !== rootRowStyle;
    if (invalidateCache) {
      rowStyleCache.current = Object.create(null);
    }

    const rows: React.JSX.Element[] = [];

    for (let i = 0; i < renderedRows.length; i += 1) {
      const { id, model } = renderedRows[i];
      const isRowNotVisible = isRowWithFocusedCellNotInRange && cellFocus!.id === id;

      const lastVisibleRowIndex = isRowWithFocusedCellNotInRange
        ? firstRowToRender + i === currentPage.rows.length
        : firstRowToRender + i === currentPage.rows.length - 1;
      const baseRowHeight = !apiRef.current.rowHasAutoHeight(id)
        ? apiRef.current.unstable_getRowHeight(id)
        : 'auto';

      let isSelected: boolean;
      if (selectedRowsLookup[id] == null) {
        isSelected = false;
      } else {
        isSelected = apiRef.current.isRowSelectable(id);
      }

      const focusedCell = cellFocus !== null && cellFocus.id === id ? cellFocus.field : null;

      const columnWithFocusedCellNotInRange =
        focusedCellColumnIndexNotInRange !== undefined &&
        visibleColumns[focusedCellColumnIndexNotInRange];

      const renderedColumnsWithFocusedCell =
        columnWithFocusedCellNotInRange && focusedCell
          ? [columnWithFocusedCellNotInRange, ...renderedColumns]
          : renderedColumns;

      let tabbableCell: GridRowProps['tabbableCell'] = null;
      if (cellTabIndex !== null && cellTabIndex.id === id) {
        const cellParams = apiRef.current.getCellParams(id, cellTabIndex.field);
        tabbableCell = cellParams.cellMode === 'view' ? cellTabIndex.field : null;
      }

      const { style: rowStyle, ...rowProps } =
        (typeof getRowProps === 'function' && getRowProps(id, model)) || {};

      if (!rowStyleCache.current[id]) {
        const style = {
          ...rowStyle,
          ...rootRowStyle,
        };
        rowStyleCache.current[id] = style;
      }

      rows.push(
        <rootProps.slots.row
          key={id}
          row={model}
          rowId={id}
          focusedCellColumnIndexNotInRange={focusedCellColumnIndexNotInRange}
          isNotVisible={isRowNotVisible}
          rowHeight={baseRowHeight}
          focusedCell={focusedCell}
          tabbableCell={tabbableCell}
          renderedColumns={renderedColumnsWithFocusedCell}
          visibleColumns={visibleColumns}
          visiblePinnedColumns={visiblePinnedColumns}
          firstColumnToRender={firstColumnToRender}
          lastColumnToRender={lastColumnToRender}
          selected={isSelected}
          index={rowIndexOffset + (currentPage?.range?.firstRowIndex || 0) + firstRowToRender + i}
          containerWidth={availableSpace}
          isLastVisible={lastVisibleRowIndex}
          {...rowProps}
          {...rootRowProps}
          style={rowStyleCache.current[id]}
        />,
      );
    }

    prevGetRowProps.current = getRowProps;
    prevRootRowStyle.current = rootRowStyle;

    return rows;
  };

  const needsHorizontalScrollbar =
    containerDimensions.width && columnsTotalWidth >= containerDimensions.width;

  const rootStyle = React.useMemo(
    () =>
      ({
        overflowX: !needsHorizontalScrollbar ? 'hidden' : undefined,
        overflowY: rootProps.autoHeight ? 'hidden' : undefined,
      } as React.CSSProperties),
    [needsHorizontalScrollbar, rootProps.autoHeight],
  );

  const contentSize = React.useMemo(() => {
    // In cases where the columns exceed the available width,
    // the horizontal scrollbar should be shown even when there're no rows.
    // Keeping 1px as minimum height ensures that the scrollbar will visible if necessary.
    const height = Math.max(rowsMeta.currentPageTotalHeight, 1);

    let shouldExtendContent = false;
    if (rootRef.current && height <= rootRef.current.clientHeight) {
      shouldExtendContent = true;
    }

    const size: React.CSSProperties = {
      width: needsHorizontalScrollbar ? columnsTotalWidth : 'auto',
      height,
      minHeight: shouldExtendContent ? '100%' : 'auto',
    };

    if (rootProps.autoHeight && currentPage.rows.length === 0) {
      size.height = getMinimalContentHeight(apiRef, rootProps.rowHeight); // Give room to show the overlay when there no rows.
    }

    return size;
  }, [
    apiRef,
    rootRef,
    columnsTotalWidth,
    rowsMeta.currentPageTotalHeight,
    needsHorizontalScrollbar,
    rootProps.autoHeight,
    rootProps.rowHeight,
    currentPage.rows.length,
  ]);

  React.useEffect(() => {
    apiRef.current.publishEvent('virtualScrollerContentSizeChange');
  }, [apiRef, contentSize]);

  useEnhancedEffect(() => {
    // FIXME: Is this really necessary?
    apiRef.current.resize();
  }, [rowsMeta.currentPageTotalHeight]);

  useEnhancedEffect(() => {
    if (enabled) {
      // TODO a scroll reset should not be necessary
      rootRef.current!.scrollLeft = 0;
      rootRef.current!.scrollTop = 0;
    } else {
      gridRootRef.current!.style.setProperty('--private_DataGrid-offsetTop', '0px');
      gridRootRef.current!.style.setProperty('--private_DataGrid-offsetLeft', '0px');
    }
  }, [enabled]);

  useEnhancedEffect(() => {
    if (containerDimensions.width == 0) {
      return;
    }

    const initialRenderContext = computeRenderContext();
    updateRenderContext(initialRenderContext);

    apiRef.current.publishEvent('scrollPositionChange', {
      top: scrollPosition.top,
      left: scrollPosition.left,
      renderContext: initialRenderContext,
    });
  }, [apiRef, containerDimensions.width, computeRenderContext, updateRenderContext]);

  apiRef.current.register('private', {
    getRenderContext,
  });

  return {
    renderContext,
    getRows,
    getRootProps: (inputProps: { style?: object } = {}) => ({
      ref: handleRef,
      onScroll: handleScroll,
      onWheel: handleWheel,
      onTouchMove: handleTouchMove,
      ...inputProps,
      style: inputProps.style ? { ...inputProps.style, ...rootStyle } : rootStyle,
      role: 'presentation',
    }),
    getContentProps: () => ({
      style: contentSize,
      role: 'presentation',
    }),
    getRenderZoneProps: () => ({ ref: renderZoneRef, role: 'rowgroup' }),
    setVisiblePinnedColumns,
  };
};

function createGetRenderedColumns() {
  // The `maxSize` is 3 so that reselect caches the `renderedColumns` values for the pinned left,
  // unpinned, and pinned right sections.
  const memoizeOptions = { maxSize: 3 };

  return defaultMemoize(
    (
      columns: GridStateColDef[],
      firstColumnToRender: number,
      lastColumnToRender: number,
      minFirstColumn: number,
      maxLastColumn: number,
      indexOfColumnWithFocusedCell: number,
    ) => {
      // If the selected column is not within the current range of columns being displayed,
      // we need to render it at either the left or right of the columns,
      // depending on whether it is above or below the range.
      let focusedCellColumnIndexNotInRange;

      const renderedColumns = columns.slice(firstColumnToRender, lastColumnToRender);

      if (indexOfColumnWithFocusedCell > -1) {
        // check if it is not on the left pinned column.
        if (
          firstColumnToRender > indexOfColumnWithFocusedCell &&
          indexOfColumnWithFocusedCell >= minFirstColumn
        ) {
          focusedCellColumnIndexNotInRange = indexOfColumnWithFocusedCell;
        }
        // check if it is not on the right pinned column.
        else if (
          lastColumnToRender < indexOfColumnWithFocusedCell &&
          indexOfColumnWithFocusedCell < maxLastColumn
        ) {
          focusedCellColumnIndexNotInRange = indexOfColumnWithFocusedCell;
        }
      }

      return {
        focusedCellColumnIndexNotInRange,
        renderedColumns,
      };
    },
    memoizeOptions,
  );
}
