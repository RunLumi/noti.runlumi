import { useMemo } from 'react';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { IconChevronRight, IconRepeat } from '@tabler/icons-react';
import { Badge, Button } from '../components/ui';
import { t } from '../i18n';
import type { DeliveryItem } from './api';
import { STATE_LABEL, destinationName } from './copy';
import { StateChip } from './StateChip';
import { Time } from './Time';
import { useLocale } from '../i18n/LocaleProvider';

const column = createColumnHelper<DeliveryItem>();

interface DeliveryTableProps {
  readonly rows: readonly DeliveryItem[];
  readonly onOpen: (delivery: DeliveryItem, trigger: HTMLElement) => void;
}

/**
 * Explicit ARIA roles on a div-less table: the narrow layout turns rows into stacked cards
 * with CSS `display`, which would otherwise drop table semantics in some browsers.
 */
export function DeliveryTable({ rows, onOpen }: DeliveryTableProps) {
  useLocale();
  const columns = useMemo(
    () => [
      column.accessor('state', {
        id: 'state',
        header: () => t('deliveries.col.state'),
        cell: (c) => (
          <>
            <StateChip state={c.getValue()} />
            {c.row.original.replayOf && (
              <span className="redelivery-tag">
                <IconRepeat size={14} aria-hidden="true" />
                {t('deliveries.redelivery')}
              </span>
            )}
          </>
        ),
      }),
      column.accessor((d) => d.integration.name, {
        id: 'integration',
        header: () => t('deliveries.col.integration'),
        cell: (c) => {
          const d = c.row.original;
          return (
            <>
              <span className="cell-main">
                {d.integrationExists ? d.integration.name : t('deliveries.integrationDeleted')}
                {d.isTest && (
                  <>
                    {' '}
                    <Badge>{t('delivery.testBadge')}</Badge>
                  </>
                )}
              </span>
              {d.integration.repo && <span className="cell-sub">{d.integration.repo}</span>}
            </>
          );
        },
      }),
      column.accessor((d) => d.integration.destination, {
        id: 'destination',
        header: () => t('deliveries.col.destination'),
        cell: (c) => {
          const d = c.row.original.integration;
          return (
            <>
              <span className="cell-main">{destinationName(d.destination)}</span>
              {d.destinationHost && <span className="cell-sub">{d.destinationHost}</span>}
            </>
          );
        },
      }),
      column.accessor('attempts', { id: 'attempts', header: () => t('deliveries.col.attempts') }),
      column.accessor('updatedAt', {
        id: 'updated',
        header: () => t('deliveries.col.updated'),
        cell: (c) => <Time iso={c.getValue()} />,
      }),
      column.display({
        id: 'details',
        header: () => <span className="sr-only">{t('deliveries.col.details')}</span>,
        cell: (c) => {
          const d = c.row.original;
          return (
            <Button
              variant="outline"
              type="button"
              className="row-action"
              aria-label={t('deliveries.detailsFor', {
                name: d.integrationExists ? d.integration.name : t('deliveries.integrationDeleted'),
                state: t(STATE_LABEL[d.state]),
              })}
              onClick={(e) => onOpen(d, e.currentTarget)}
            >
              {t('deliveries.details')}
              <IconChevronRight size={16} aria-hidden="true" />
            </Button>
          );
        },
      }),
    ],
    [onOpen],
  );
  const table = useReactTable({
    data: rows as DeliveryItem[],
    columns,
    // Key rows by delivery id so a row that moves (a new redelivery lands on top) keeps its DOM
    // node and with it the focus the detail dialog returns to.
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="table-wrap card delivery-table-wrap">
      <table className="delivery-table" role="table" aria-label={t('deliveries.tableLabel')}>
        <thead role="rowgroup">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} role="row">
              {group.headers.map((h) => (
                <th key={h.id} role="columnheader" scope="col">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody role="rowgroup">
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} role="row">
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  role="cell"
                  data-label={headerText(cell.column.id) || undefined}
                  className={`cell-${cell.column.id}`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The visible column name shown beside a value when rows are stacked on a narrow screen. */
function headerText(id: string): string {
  switch (id) {
    case 'state':
      return t('deliveries.col.state');
    case 'integration':
      return t('deliveries.col.integration');
    case 'destination':
      return t('deliveries.col.destination');
    case 'attempts':
      return t('deliveries.col.attempts');
    case 'updated':
      return t('deliveries.col.updated');
    default:
      return '';
  }
}
