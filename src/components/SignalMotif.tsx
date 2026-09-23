"use client";

// Decorative node graph — represents connected participants in a live meeting.
export function SignalMotif() {
  const nodes = [
    { x: 60, y: 80 }, { x: 220, y: 40 }, { x: 340, y: 140 },
    { x: 140, y: 220 }, { x: 300, y: 300 }, { x: 70, y: 340 },
  ];
  const links = [[0,1],[1,2],[0,3],[3,4],[3,5],[1,4]];
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full">
      {links.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].x} y1={nodes[a].y}
          x2={nodes[b].x} y2={nodes[b].y}
          stroke="var(--text-muted)"
          strokeOpacity="0.3"
          strokeWidth="1.5"
        />
      ))}
      {nodes.map((n, i) => (
        <circle
          key={i}
          cx={n.x} cy={n.y}
          r={i === 3 ? 14 : 9}
          fill={i === 3 ? "var(--accent)" : "var(--text-muted)"}
          fillOpacity={i === 3 ? 1 : 0.6}
        >
          <animate
            attributeName="opacity"
            values="0.6;1;0.6"
            dur={`${2.5 + i * 0.4}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  );
}
