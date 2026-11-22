import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Button } from "../../web/src/components/ui/button";
import { Badge } from "../../web/src/components/ui/badge";
import { Skeleton } from "../../web/src/components/ui/skeleton";
import { Spinner } from "../../web/src/components/ui/spinner";

const titles = [
  "Rework authentication",
  "Build the dashboard",
  "Fix failing tests",
  "Review the API",
];
const ramp = (frame: number, input: number[], output: number[]) =>
  interpolate(frame, input, output, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

export function Opener() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = spring({ frame, fps, config: { damping: 24, stiffness: 100 } });
  const frozenFrame = Math.min(frame, 60);
  const reduced = frame >= 105;
  const fade = ramp(frame, [198, 209], [1, 0]);
  const zoom = ramp(frame, [60, 104, 105, 195], [1, 1.12, 1.06, 1.13]);
  const headlineOpacity = reduced
    ? ramp(frame, [113, 122, 190, 198], [0, 1, 1, 0])
    : ramp(frame, [9, 19, 90, 96], [0, 1, 1, 0]);
  const click = ramp(frame, [69, 74, 83], [0, 1, 0]);

  return (
    <AbsoluteFill className="scene dark">
      <div style={{ opacity: fade }}>
        <div className="beat" style={{ opacity: headlineOpacity }}>
          {reduced ? "Fewer threads. Still stuck." : "4 agents on an 8GB laptop"}
        </div>
        <div
          className="window"
          style={{
            opacity: entrance,
            transform: `translateY(${(1 - entrance) * 90}px) scale(${(0.96 + entrance * 0.04) * zoom})`,
          }}
        >
          <div className="toolbar">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span className="secondary" style={{ marginLeft: 38 }}>
              Workspace / web-app
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
              {titles.slice(0, reduced ? 2 : 4).map((title, index) => (
                <div className={`thread ${index === 0 ? "active" : ""}`} key={title}>
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
                <span style={{ fontSize: 24 }}>Rework authentication</span>
                <Badge variant="outline" size="lg">
                  Agent
                </Badge>
              </div>
              <div style={{ textAlign: "right", marginTop: 34 }}>
                <Badge variant="secondary" size="lg" style={{ padding: "18px 22px", fontSize: 20 }}>
                  Add sign-in and session handling.
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
                <span>Inspecting the authentication flow</span>
              </div>
              <div style={{ marginTop: 25, display: "grid", gap: 15 }}>
                <Skeleton style={{ height: 13, width: "88%" }} />
                <Skeleton style={{ height: 13, width: "73%" }} />
                <Skeleton style={{ height: 13, width: "80%" }} />
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
      <div
        style={{
          position: "absolute",
          right: 45,
          bottom: 25,
          fontSize: 15,
          letterSpacing: 3,
          color: "#85858a",
        }}
      >
        SIMULATED
      </div>
    </AbsoluteFill>
  );
}
