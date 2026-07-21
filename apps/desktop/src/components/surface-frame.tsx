import { useCallback, useRef, useState } from "react";

/**
 * Animated 灵光 (Lingguang) loader — a "spark of light" sparkle mark on the
 * brand indigo→violet gradient that gently breathes while a small secondary
 * sparkle twinkles. Pure CSS/SVG, no framer-motion dependency. Matches the
 * app icon so boot and installed identity stay consistent.
 */
function NexuLoader({ size = 48 }: { size?: number }) {
  return (
    <>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Loading"
      >
        <defs>
          <linearGradient
            id="lingguang-loader-grad"
            x1="12"
            y1="8"
            x2="88"
            y2="92"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#4F5BF2" />
            <stop offset="1" stopColor="#9244EE" />
          </linearGradient>
        </defs>
        {/* Main sparkle — breathes (scale + opacity) */}
        <path
          className="lg-spark lg-spark-main"
          d="M50 6 C 55 33, 67 45, 94 50 C 67 55, 55 67, 50 94 C 45 67, 33 55, 6 50 C 33 45, 45 33, 50 6 Z"
          fill="url(#lingguang-loader-grad)"
        />
        {/* Secondary sparkle — twinkles on a delay */}
        <path
          className="lg-spark lg-spark-mini"
          d="M81 10 C 82 17, 85 20, 92 21 C 85 22, 82 25, 81 32 C 80 25, 77 22, 70 21 C 77 20, 80 17, 81 10 Z"
          fill="url(#lingguang-loader-grad)"
        />
      </svg>
      <style>{`
        .lg-spark {
          transform-origin: center;
        }
        .lg-spark-main {
          animation: lg-breathe 1.8s ease-in-out infinite;
        }
        .lg-spark-mini {
          transform-origin: 81px 21px;
          animation: lg-twinkle 1.8s ease-in-out infinite;
          animation-delay: 0.35s;
        }
        @keyframes lg-breathe {
          0%, 100% { opacity: 0.55; transform: scale(0.9); }
          50%      { opacity: 1;    transform: scale(1.04); }
        }
        @keyframes lg-twinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.6); }
          50%      { opacity: 1;   transform: scale(1); }
        }
      `}</style>
    </>
  );
}

export function SurfaceFrame({
  title: _title,
  description: _description,
  src,
  version,
  preload,
}: {
  title: string;
  description: string;
  src: string | null;
  version: number;
  preload?: string;
}) {
  void _title;
  void _description;
  const [webviewReady, setWebviewReady] = useState(false);
  const prevSrcRef = useRef<string | null>(null);

  // Reset when src changes
  if (src !== prevSrcRef.current) {
    prevSrcRef.current = src;
    if (webviewReady) setWebviewReady(false);
  }

  const webviewRefCallback = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !src) return;
      if (preload) {
        el.setAttribute("preload", preload);
      }
      // Listen for did-finish-load right on the element before setting src.
      // This avoids the race where dom-ready fires before useEffect can bind.
      el.addEventListener("did-finish-load", () => setWebviewReady(true), {
        once: true,
      });
      el.setAttribute("src", src);
    },
    [preload, src],
  );

  const showLoader = !src || !webviewReady;

  return (
    <section className="surface-frame" style={{ position: "relative" }}>
      {/* Webview always rendered (hidden behind loader until ready) */}
      {src && (
        <webview
          ref={webviewRefCallback as React.Ref<HTMLWebViewElement>}
          className="desktop-web-frame"
          key={`${src}:${version}`}
          // @ts-expect-error Electron webview boolean attribute — must be empty string, not boolean
          allowpopups=""
          style={{ opacity: webviewReady ? 1 : 0 }}
        />
      )}

      {/* Loader overlay — covers webview until content is ready */}
      {showLoader && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "#ffffff",
            zIndex: 10,
            transition: "opacity 0.3s ease-out",
          }}
        >
          <NexuLoader size={96} />
        </div>
      )}
    </section>
  );
}
