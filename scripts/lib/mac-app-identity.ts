export const MAC_APP_NAME = "Crate";
export const MAC_APP_ID = "com.thomasbrugman.crate";

export const isPackagedMacApp = (input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
}) => input.platform === "darwin" && input.isPackaged;
