/** The control room's first paint: the same panels, in the same places, while the API answers. */
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-[1480px] animate-pulse px-4 pb-24 pt-7 sm:px-6 lg:px-8">
      <div className="h-3 w-24 rounded-full bg-white/10" />
      <div className="mt-3 h-8 w-64 rounded-lg bg-white/10" />
      <div className="mt-3 h-4 w-[420px] max-w-full rounded bg-white/[0.07]" />

      <div className="panel mt-7 h-[168px]" />
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="panel h-[420px]" />
        <div className="glow-panel h-[420px] opacity-70" />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="panel h-[300px]" />
        <div className="panel h-[300px]" />
      </div>
      <div className="panel mt-6 h-[340px]" />
    </div>
  );
}
