/** The control room's first paint: the same trays, in the same places, while the API answers. */
export default function DashboardLoading() {
  return (
    <div className="flex min-h-0 flex-1 animate-pulse flex-col gap-4 px-4 pb-4 pt-4 sm:px-6 xl:px-7 xl:pb-5">
      <div className="grid shrink-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,2fr)]">
        <div className="flex flex-col justify-center gap-2 px-1">
          <div className="well h-2.5 w-24 rounded-full!" />
          <div className="well h-7 w-80 max-w-full rounded-lg!" />
          <div className="well h-3.5 w-[420px] max-w-full rounded!" />
        </div>
        <div className="tray h-[112px]" />
      </div>
      <div className="grid min-h-0 gap-4 xl:flex-1 xl:grid-cols-[minmax(270px,300px)_minmax(0,1fr)_minmax(320px,360px)] 2xl:grid-cols-[330px_minmax(0,1fr)_390px]">
        <div className="tray min-h-[480px] xl:min-h-0" />
        <div className="flex min-h-0 flex-col gap-4">
          <div className="tile inverse min-h-[380px] rounded-[30px]! xl:min-h-0 xl:flex-[1.75]" />
          <div className="tray min-h-[300px] xl:min-h-0 xl:flex-1" />
        </div>
        <div className="flex min-h-0 flex-col gap-4">
          <div className="tray min-h-[380px] xl:min-h-0 xl:flex-[1.4]" />
          <div className="tray min-h-[240px] xl:min-h-0 xl:flex-1" />
        </div>
      </div>
    </div>
  );
}
