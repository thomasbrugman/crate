import { AbsoluteFill, Easing, interpolate } from "remotion";

const jobs = ["README edit", "Install review", "Phone pairing", "Review tests"];
const barcode = [2, 4, 1, 3, 1, 2, 5, 2, 1, 4, 2, 3, 5, 1, 2, 3, 1, 4, 1, 2];
const bars = barcode.reduce(
  ({ x, path }, unit) => ({
    x: x + unit * 3 + 3,
    path: `${path}M${x} 0h${unit * 3}v30h${-unit * 3}z`,
  }),
  { x: 0, path: "" },
);
const ease = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

function Label({ index }: { index: number }) {
  return (
    <div className={`thermal-label ${index === 0 ? "priority-label" : ""}`}>
      <header>
        <span>t3stash / work order</span>
        <span>TS-00{index + 1}</span>
      </header>
      <strong>{jobs[index]}</strong>
      <div className="thermal-code">
        <svg aria-hidden viewBox={`0 0 ${bars.x} 30`} width={bars.x} height={30}>
          <path fill="currentColor" d={bars.path} />
        </svg>
        <span aria-hidden>↗</span>
      </div>
    </div>
  );
}

export function PrinterJam({ frame }: { frame: number }) {
  const stopped = frame >= 60;
  const order = ease(frame, 119, 151);
  const pull = ease(frame, 151, 209);
  return (
    <div className="printer">
      <div className="printer-title">
        <span>LOCAL DISPATCH</span>
        <span>01 DOCK / 8 GB</span>
      </div>
      <div className="printer-tray">
        {jobs.map((job, index) => {
          const arrive = ease(Math.min(frame, 60), 9 + index * 10, 47 + index * 5);
          const tuck = ease(frame, 73, 114);
          const raise = index === 0 ? order : 0;
          return (
            <div
              className="printed"
              key={job}
              style={{
                opacity: arrive * (index >= 2 ? 1 - tuck : index === 0 && pull > 0 ? 0 : 1),
                zIndex: index === 0 && raise > 0 ? 6 : index,
                transform: `translate(${index * 14 - 45 * raise}px, ${-210 + arrive * (267 + index * 105) - 56 * raise}px) rotate(${arrive * [3, -7, 8, -4][index]! * (1 - raise)}deg)`,
              }}
            >
              <Label index={index} />
            </div>
          );
        })}
        <div className="printer-slot" />
      </div>
      <div className={`printer-status ${stopped ? "printer-error" : ""}`}>
        <i />
        {stopped ? "QUEUE JAM / NOT RESPONDING" : "PRINTING WORK ORDERS"}
      </div>
      {pull > 0 && (
        <div
          className="pull-order"
          style={{
            transform: `translate(${-568 * pull}px, ${192 * pull}px) rotate(${-8 * pull}deg) scale(${1.14 + 0.38 * pull})`,
          }}
        >
          <Label index={0} />
        </div>
      )}
    </div>
  );
}

export function DispatchReveal({ frame }: { frame: number }) {
  const open = ease(frame, 203, 221);
  const text = ease(frame, 211, 228);
  return (
    <AbsoluteFill className="dispatch" style={{ clipPath: `inset(0 0 0 ${100 * (1 - open)}%)` }}>
      <header className="dispatch-header">
        <span>t3stash / dispatch</span>
        <span>ROUTING: LOCAL → CLOUD</span>
      </header>
      <div
        className="dispatch-copy"
        style={{ transform: `translateY(${(1 - text) * 36}px)`, opacity: text }}
      >
        <span className="dispatch-kicker">UPSTASH BOX × T3 CODE</span>
        <strong>t3stash</strong>
        <p>
          Give each thread
          <br />
          its own cloud Box.
        </p>
      </div>
      <div className="dispatch-rack">
        {jobs.slice(0, 3).map((job, index) => {
          const dock = ease(frame, 207 + index * 5, 230 + index * 4);
          return (
            <div className="dispatch-dock" key={job}>
              <span>BOX 0{index + 1}</span>
              <div style={{ transform: `translateX(${(1 - dock) * 370}px)`, opacity: dock }}>
                <Label index={index} />
              </div>
            </div>
          );
        })}
      </div>
      <footer className="dispatch-footer">
        <span>TRACKING / TS-001</span>
        <span>→</span>
      </footer>
    </AbsoluteFill>
  );
}
