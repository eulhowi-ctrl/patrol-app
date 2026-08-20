// 차트 데이터 타입 — src/components/charts/*.tsx(렌더링)와 src/lib/dashboardStats.ts(순수 집계
// 로직, 테스트 대상)가 공유한다. 여기 있는 순수 .ts 파일에 둬서, JSX를 파싱할 필요가 없는
// 테스트 하네스(ts-node)에서도 집계 로직을 문제없이 import할 수 있게 한다.
export interface BarDatum {
  label: string;
  value: number;
  color?: string;
}

export interface DonutDatum {
  label: string;
  value: number;
  color: string;
}
