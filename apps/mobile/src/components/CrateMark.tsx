import { Image } from "react-native";

const mark = require("../../../../assets/prod/t3-black-web-apple-touch-180.png");

export function CrateMark({ size }: { readonly size: number }) {
  return <Image accessibilityElementsHidden source={mark} style={{ width: size, height: size }} />;
}
