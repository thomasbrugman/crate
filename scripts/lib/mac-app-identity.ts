export const MAC_APP_NAME = "t3stash";
export const MAC_APP_ID = "com.thomasbrugman.t3stash";

export const isPackagedMacApp = (input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
}) => input.platform === "darwin" && input.isPackaged;
