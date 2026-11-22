import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import manifest from "../../../package.json";
import { Button } from "../../web/src/components/ui/button";
import { Badge } from "../../web/src/components/ui/badge";
import { Spinner } from "../../web/src/components/ui/spinner";
import { DispatchReveal, PrinterJam } from "./ShippingLabels";

const titles = ["README edit", "Install review", "Phone pairing", "Review tests"];
const source = JSON.stringify(
  { engines: manifest.engines, packageManager: manifest.packageManager },
  null,
  2,
);
const ramp = (frame: number, input: number[], output: number[]) =>
  interpolate(frame, input, output, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
const ease = (n: number) => (1 - Math.cos(n * Math.PI)) / 2;

export function Opener() {
  const renderFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frame = (renderFrame * 30) / fps;
  const entrance = spring({ frame: renderFrame, fps, config: { damping: 24, stiffness: 100 } });
  const frozenFrame = Math.min(frame, 60);
  const reduced = frame >= 93;
  const camera = ease(ramp(frame, [51, 183], [0, 1]));
  const retry = ease(ramp(frame, [68, 97], [0, 1]));
  const sourceIn = ease(ramp(frozenFrame, [10, 28], [0, 1]));
  const highlight = ramp(frozenFrame, [30, 55], [0, 1]);
  const headlineOpacity = reduced
    ? ramp(frame, [93, 105, 188, 201], [0, 1, 1, 0])
    : ramp(frame, [9, 19, 76, 92], [0, 1, 1, 0]);
  const click = ramp(frame, [69, 74, 83], [0, 1, 0]);

  return (
    <AbsoluteFill className="scene dark">
      <div>
        <div className="jam-header">
          <span>01 / INTAKE</span>
          <span>t3stash / dispatch</span>
        </div>
        <div className="beat" style={{ opacity: headlineOpacity }}>
          {reduced ? "Fewer threads. Still stuck." : "4 agents on an 8 GB laptop."}
        </div>
        <div
          className="window"
          style={{
            opacity: entrance,
            transform: `translate(${-68 * camera}px, ${(1 - entrance) * 60 - 27 * camera}px) scale(${(0.66 + entrance * 0.04) * (1 + 0.13 * camera)})`,
          }}
        >
          <div className="toolbar">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="secondary" style={{ marginLeft: 38 }}>
              T3 Code / t3stash
            </span>
          </div>
          <div style={{ display: "flex", height: 662 }}>
            <aside
              style={{
                width: 470,
                flexShrink: 0,
                padding: "26px 20px",
                background: "var(--sidebar)",
                borderRight: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 28,
                  padding: "0 16px",
                }}
              >
                <span className="secondary">THREADS</span>
                <Button variant="outline" size="sm">
                  + New thread
                </Button>
              </div>
              {titles.map((title, index) => (
                <div
                  className={`thread ${index === 0 ? "active" : ""}`}
                  key={title}
                  style={
                    index >= 2
                      ? { opacity: 1 - retry, transform: `translateX(${-55 * retry}px)` }
                      : undefined
                  }
                >
                  <Spinner
                    style={{
                      width: 25,
                      height: 25,
                      flexShrink: 0,
                      transform: `rotate(${frozenFrame * 10 + index * 75}deg)`,
                    }}
                  />
                  <div>
                    <div className="thread-title">{title}</div>
                    <div className="secondary">Working…</div>
                  </div>
                </div>
              ))}
            </aside>
            <main style={{ flex: 1, padding: "30px 48px", position: "relative" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderBottom: "1px solid var(--border)",
                  paddingBottom: 24,
                }}
              >
                <span style={{ fontSize: 24 }}>README edit</span>
                <Badge variant="outline" size="lg">
                  Agent
                </Badge>
              </div>
              <div style={{ textAlign: "right", marginTop: 34 }}>
                <Badge variant="secondary" size="lg" style={{ padding: "18px 22px", fontSize: 20 }}>
                  Fix the Node version in the t3stash README.
                </Badge>
              </div>
              <div
                style={{
                  marginTop: 45,
                  fontSize: 22,
                  display: "flex",
                  alignItems: "center",
                  gap: 13,
                }}
              >
                <Spinner
                  style={{ width: 22, height: 22, transform: `rotate(${frozenFrame * 10}deg)` }}
                />
                <span>Checking package.json</span>
              </div>
              <div
                className="source-preview"
                style={{ opacity: sourceIn, transform: `translateY(${30 * (1 - sourceIn)}px)` }}
              >
                <div>
                  t3stash / package.json <span>EXCERPT</span>
                </div>
                <pre>
                  {source.split("\n").map((line) => (
                    <span
                      key={line}
                      style={
                        line.includes('"node"')
                          ? { backgroundColor: `rgb(255 120 73 / ${0.23 * highlight})` }
                          : undefined
                      }
                    >
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              </div>
              <div
                style={{
                  position: "absolute",
                  bottom: 33,
                  left: 48,
                  right: 48,
                  border: "1px solid var(--border)",
                  borderRadius: 15,
                  padding: 23,
                  background: "var(--card)",
                }}
              >
                <div className="secondary" style={{ marginBottom: 27 }}>
                  Send a follow-up…
                </div>
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <Badge variant="outline">Agent · Default</Badge>
                  <Button variant="outline" size="sm">
                    Stop
                  </Button>
                </div>
              </div>
            </main>
          </div>
          <div
            style={{
              position: "absolute",
              left: ramp(frozenFrame, [0, 30, 60], [920, 700, 380]),
              top: ramp(frozenFrame, [0, 30, 60], [520, 350, 227]),
              width: 35,
              height: 45,
            }}
          >
            <svg viewBox="0 0 32 40" width="32" height="40">
              <path
                d="M3 2L5 32L13 25L19 37L25 34L19 22L30 21Z"
                fill="white"
                stroke="#111"
                strokeWidth="2"
              />
            </svg>
            <div
              style={{
                position: "absolute",
                top: -15,
                left: -15,
                width: 50 + click * 24,
                height: 50 + click * 24,
                borderRadius: "50%",
                border: "2px solid white",
                opacity: click * 0.65,
                transform: "translate(-25%, -25%)",
              }}
            />
          </div>
        </div>
      </div>
      <PrinterJam frame={frame} />
      <div
        style={{
          position: "absolute",
          right: 45,
          bottom: 25,
          fontSize: 15,
          letterSpacing: 3,
          color: "#b2ada3",
        }}
      >
        SIMULATED
      </div>
      <DispatchReveal frame={frame} />
    </AbsoluteFill>
  );
}
