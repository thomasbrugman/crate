import { cx, type CxOptions } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

// The web helper also imports application stores; this scene only needs class merging.
export const cn = (...inputs: CxOptions) => twMerge(cx(inputs));
