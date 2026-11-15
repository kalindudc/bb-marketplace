import type { TaleResults as Results } from "../../shared/tale-results";
import { Chart } from "./charts";
import { FigureRow } from "./quest-map";

export function TaleResults({ results, compact = false }: { results?: Results; compact?: boolean }) {
  if (!results) return null;
  const chart = results.chart;
  const decimals = chart ? Math.max(...chart.series.flatMap(series => series.values.map(value => (value.toFixed(2).replace(/0+$/, "").split(".")[1] ?? "").length))) : 0;
  return <div className={`tale-results ${compact ? "compact" : ""}`} role="group" aria-label="Keeper results">
    {results.figures.length > 0 && <FigureRow compact={compact} figures={results.figures} />}
    {chart && <section aria-label={chart.title}>
      <h4>{chart.title}</h4>
      <Chart type={chart.type} unit={chart.unit} format={(value, unit) => `${value?.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: 2 }) ?? "no data"}${unit ? ` ${unit}` : ""}`} series={chart.series.map((series, i) => ({ id: String(i), label: series.name, unit: chart.unit ?? "", points: chart.labels.map((x, j) => ({ x, y: series.values[j]! })) }))} />
      <table className="sr" aria-label={`${chart.title} values`}><caption>{chart.title}{chart.unit ? ` in ${chart.unit}` : ""}</caption><thead><tr><th scope="col">Label</th>{chart.series.map((series, i) => <th key={i} scope="col">{series.name}</th>)}</tr></thead><tbody>{chart.labels.map((label, i) => <tr key={i}><th scope="row">{label}</th>{chart.series.map((series, j) => <td key={j}>{series.values[i]}</td>)}</tr>)}</tbody></table>
    </section>}
  </div>;
}
