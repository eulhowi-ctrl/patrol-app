import type { BarDatum } from "../../lib/chartTypes";

export type { BarDatum };

interface BarChartProps {
  data: BarDatum[];
  orientation?: "horizontal" | "vertical";
  unit?: string;
}

const DEFAULT_COLOR = "#1f6feb";

// 대시보드 전용 — 별도 라이브러리 없이 순수 CSS로 그리는 막대 차트.
// horizontal: 위반 유형별 건수 목록 / vertical: 일자별 추이(스파크라인 느낌)
export default function BarChart({ data, orientation = "horizontal", unit = "건" }: BarChartProps) {
  const max = Math.max(1, ...data.map((d) => d.value));

  if (orientation === "vertical") {
    return (
      <div className="bar-chart bar-chart-vertical">
        {data.map((d) => (
          <div className="bar-col" key={d.label}>
            <div className="bar-col-value">{d.value}</div>
            <div className="bar-col-track">
              <div
                className="bar-col-fill"
                style={{ height: `${(d.value / max) * 100}%`, background: d.color ?? DEFAULT_COLOR }}
              />
            </div>
            <div className="bar-col-label">{d.label}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bar-chart bar-chart-horizontal">
      {data.map((d) => (
        <div className="bar-row" key={d.label}>
          <div className="bar-row-label">{d.label}</div>
          <div className="bar-row-track">
            <div
              className="bar-row-fill"
              style={{ width: `${(d.value / max) * 100}%`, background: d.color ?? DEFAULT_COLOR }}
            />
          </div>
          <div className="bar-row-value">
            {d.value}{unit}
          </div>
        </div>
      ))}
    </div>
  );
}
