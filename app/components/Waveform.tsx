"use client";

/**
 * Static pseudo-waveform for a voice message. Heights are derived from the
 * seed so a given message always renders the same shape across re-renders.
 */
export default function Waveform({
  seed,
  bars = 26,
  className = "",
  animate = false,
}: {
  seed: number;
  bars?: number;
  className?: string;
  animate?: boolean;
}) {
  return (
    <span className={`flex items-center gap-[2px] ${className}`}>
      {Array.from({ length: bars }).map((_, i) => {
        // Rounded to a whole pixel so the server and client emit identical
        // style strings — unrounded floats cause a hydration mismatch.
        const h = Math.round(4 + Math.abs(Math.sin(seed * 1.7 + i * 0.9)) * 14);
        return (
          <span
            key={i}
            className={`w-[2px] rounded-full bg-current ${animate ? "animate-bar" : ""}`}
            style={{
              height: `${h}px`,
              animationDelay: animate ? `${i * 60}ms` : undefined,
            }}
          />
        );
      })}
    </span>
  );
}
