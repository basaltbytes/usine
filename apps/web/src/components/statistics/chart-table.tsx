type ChartTableProps = {
  readonly caption: string;
  readonly head: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<readonly [string, ...ReadonlyArray<string>]>;
};

/** The values of a chart as a table for screen readers. */
export const ChartTable = ({ caption, head, rows }: ChartTableProps) => (
  <table className="sr-only">
    <caption>{caption}</caption>
    <thead>
      <tr>
        {head.map((cell) => (
          <th key={cell} scope="col">
            {cell}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map(([name, ...cells]) => (
        <tr key={name}>
          <th scope="row">{name}</th>
          {cells.map((cell, index) => (
            <td key={head[index + 1] ?? index}>{cell}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);
