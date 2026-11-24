import appIconUrl from "../../../../assets/prod/logo.svg";

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
