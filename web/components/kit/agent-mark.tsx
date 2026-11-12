/**
 * The agent's mark: the Hermes portrait, Tessera's face for whichever agent is connected. Tessera is agent-agnostic, so
 * the mark stands for "the agent" rather than any one model; the model's name is shown beside it as metadata.
 */
export function AgentMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed local SVG; the optimizer adds nothing here.
    <img
      src="/agents/hermes-agent-on-dark.svg"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={`shrink-0 rounded-[28%] ring-1 ring-black/10 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
