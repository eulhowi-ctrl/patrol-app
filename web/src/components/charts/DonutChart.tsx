import type { DonutDatum } from "../../lib/chartTypes";

export type { DonutDatum };

interface DonutChartProps {
  data: DonutDatum[];
  centerLabel?: string;
  centerValue?: string | number;
}

// conic-gradient 기반 원형(도넛) 차트 — 별도 차트 라이브러리 없이 순수 CSS로 그린다.
export default function DonutChart({ data, centerLabel, centerValue }: DonutChartProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const visible = data.filter((d) => d.value > 0);

  let cumulative = 0;
  const stops = visible
    .map((d) => {
      const start = total > 0 ? (cumulative / total) * 360 : 0;
      cumulative += d.value;
      const end = total > 0 ? (cumulative / total) * 360 : 0;
      return `${d.color} ${start}deg ${end}deg`;
    })
    .join(", ");

  return (
    <div className="donut-chart">
      <div
        className="donut-ring"
        style={{ background: total > 0 ? `conic-gradient(${stops})` : "#2a3550" }}
      >
        <div className="donut-center">
          <div className="donut-center-value">{centerValue}</div>
          {centerLabel && <div className="donut-center-label">{centerLabel}</div>}
        </div>
      </div>
      <div className="donut-legend">
        {visible.map((d) => (
          <div className="donut-legend-item" key={d.label}>
            <span className="donut-legend-dot" style={{ background: d.color }} />
            <span className="donut-legend-label">{d.label}</span>
            <span className="donut-legend-value">
              {total > 0 ? Math.round((d.value / total) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
