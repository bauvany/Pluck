"use client";

/**
 * FractalGlass — faithful port of the Framer "FractalGlassEffects" component
 * (framer.com/m/FractalGlassEffect-XNat.js). Renders glass panels with
 * backdrop blur and gradient edge lines over the content behind them.
 */
import { useMemo, type CSSProperties } from "react";

type FractalGlassProps = {
  pattern?: "columns" | "rows" | "grid";
  columnCount?: number;
  rowCount?: number;
  opacity?: number;
  blur?: number;
  glassColor?: string;
  blendMode?: CSSProperties["mixBlendMode"];
  style?: CSSProperties;
};

export function FractalGlass({
  pattern = "columns",
  columnCount = 12,
  rowCount = 12,
  opacity = 0.8,
  blur = 10,
  glassColor = "rgba(255, 204, 187, 0.12)",
  blendMode = "overlay",
  style,
}: FractalGlassProps) {
  const elements = useMemo(() => {
    const isRows = pattern === "rows";
    const isGrid = pattern === "grid";
    const cols = Math.max(1, Math.floor(columnCount));
    const rows = Math.max(1, Math.floor(rowCount));
    const count = isGrid ? cols * rows : isRows ? rows : cols;
    return Array.from({ length: count }).map((_, i) => {
      const s: CSSProperties = {
        flex: 1,
        width: "100%",
        height: "100%",
        backdropFilter: `blur(${blur}px)`,
        WebkitBackdropFilter: `blur(${blur}px)`,
      };
      if (isRows) {
        s.background = `linear-gradient(180deg, rgba(255,204,187,0.18) 0%, rgba(255,204,187,0) 20%, rgba(255,204,187,0.04) 50%, rgba(255,204,187,0.08) 80%, rgba(255,204,187,0.18) 100%)`;
        s.borderBottom = "1px solid rgba(255,204,187,0.16)";
        s.borderTop = "1px solid rgba(255,204,187,0.08)";
        s.boxShadow = "inset 0 1px 2px rgba(255,204,187,0.12)";
      } else if (isGrid) {
        s.background = `linear-gradient(135deg, rgba(255,204,187,0.18) 0%, rgba(255,204,187,0) 20%, rgba(255,204,187,0.04) 50%, rgba(255,204,187,0.08) 80%, rgba(255,204,187,0.18) 100%)`;
        s.border = "1px solid rgba(255,204,187,0.16)";
        s.boxShadow = "inset 1px 1px 2px rgba(255,204,187,0.12)";
      } else {
        s.background = `linear-gradient(90deg, rgba(255,204,187,0.18) 0%, rgba(255,204,187,0) 20%, rgba(255,204,187,0.04) 50%, rgba(255,204,187,0.08) 80%, rgba(255,204,187,0.18) 100%)`;
        s.borderRight = "1px solid rgba(255,204,187,0.16)";
        s.borderLeft = "1px solid rgba(255,204,187,0.08)";
        s.boxShadow = "inset 1px 0 2px rgba(255,204,187,0.12)";
      }
      return <div key={i} style={s} />;
    });
  }, [pattern, columnCount, rowCount, blur]);

  const containerStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: glassColor,
    opacity,
    mixBlendMode: blendMode,
    zIndex: 1,
    pointerEvents: "none",
    display: pattern === "grid" ? "grid" : "flex",
    flexDirection: pattern === "rows" ? "column" : "row",
    ...(pattern === "grid"
      ? {
          gridTemplateColumns: `repeat(${Math.max(1, Math.floor(columnCount))}, 1fr)`,
          gridTemplateRows: `repeat(${Math.max(1, Math.floor(rowCount))}, 1fr)`,
        }
      : {}),
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
        pointerEvents: "none",
        ...style,
      }}
    >
      <div style={containerStyle}>{elements}</div>
    </div>
  );
}
