import { Outlet } from "react-router-dom";

/**
 * AuthLayout — historically gated the workspace behind a nexu-cloud login.
 * Nexu accounts have been removed; this layout is now a pass-through so any
 * fresh install lands directly in the workspace without a welcome/login flow.
 * Kept as a component so existing route trees don't need restructuring.
 */
export function AuthLayout() {
  return <Outlet />;
}
