import { Composition, registerRoot } from "remotion";
import { Opener } from "./Opener";
import "./style.css";

document.documentElement.classList.add("dark");

const Root = () => (
  <Composition
    id="Opener"
    component={Opener}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={210}
  />
);

registerRoot(Root);
