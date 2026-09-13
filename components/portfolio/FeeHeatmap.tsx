'use client';

/** Eight weeks of daily WETH fees. Darker green = more fees. */
export function FeeHeatmap({ values }: { values: number[] }) {
  const max = Math.max(...values, 0.0001);
  return (
    <div className="cal" role="img" aria-label="Daily fees over the last 8 weeks">
      {values.map((v, i) => {
        const intensity = v / max;
        return (
          <div
            key={i}
            style={{
              background:
                intensity < 0.08
                  ? 'var(--raise)'
                  : `color-mix(in srgb, var(--ac) ${Math.round(12 + intensity * 88)}%, var(--raise))`,
            }}
            title={`${v.toFixed(3)} WETH`}
          />
        );
      })}
    </div>
  );
}
