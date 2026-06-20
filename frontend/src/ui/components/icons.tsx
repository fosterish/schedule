import type { JSX } from "preact";

// Inline single-color icons; they inherit currentColor and default to 1em so
// callers size them via font-size/color. No external icon font.

type Props = JSX.SVGAttributes<SVGSVGElement>;

function svg(path: JSX.Element, props: Props): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    >
      {path}
    </svg>
  );
}

export const TrashIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </>,
    p,
  );

export const PlusIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
    p,
  );

export const CloseIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M6 6l12 12" />
      <path d="M6 18L18 6" />
    </>,
    p,
  );

// An arrow leaving up-and-right: "go to" / open the linked project or task.
export const GoToIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </>,
    p,
  );

export const ChevronLeftIcon = (p: Props): JSX.Element => svg(<path d="M15 6l-6 6 6 6" />, p);
export const ChevronRightIcon = (p: Props): JSX.Element => svg(<path d="M9 6l6 6-6 6" />, p);
export const ChevronDownIcon = (p: Props): JSX.Element => svg(<path d="M6 9l6 6 6-6" />, p);
export const ChevronUpIcon = (p: Props): JSX.Element => svg(<path d="M6 15l6-6 6 6" />, p);

export const PlayIcon = (p: Props): JSX.Element =>
  svg(<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />, p);

export const StopIcon = (p: Props): JSX.Element =>
  svg(<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />, p);

export const SkipIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M6 5l9 7-9 7z" fill="currentColor" stroke="none" />
      <path d="M17 5v14" stroke-width="2.5" />
    </>,
    p,
  );

export const GripIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <circle cx="9" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1" fill="currentColor" stroke="none" />
    </>,
    p,
  );

// Three horizontal dots for the resize grab handles on item/schedule edges.
export const DotsIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <circle cx="6" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="2" fill="currentColor" stroke="none" />
    </>,
    p,
  );

export const ZoomInIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M11 8v6M8 11h6" />
    </>,
    p,
  );

export const ZoomOutIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M8 11h6" />
    </>,
    p,
  );

export const UndoIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M9 14l-5-5 5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
    </>,
    p,
  );

export const RedoIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h4" />
    </>,
    p,
  );

// A broom: sweep away / clear-out completed items. Handle, ferrule, then four
// splayed bristles drawn as distinct strands.
export const BroomIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M12 3v8.5" />
      <path d="M8 11.5h8" />
      <path d="M9 11.5L8 20" />
      <path d="M11 11.5l-0.3 7.7" />
      <path d="M13 11.5l0.3 8.5" />
      <path d="M15 11.5L16 19.2" />
    </>,
    p,
  );

// An archive box: a lid over a bin with a handle slot.
export const ArchiveIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>,
    p,
  );

// A cog for the Settings tab.
export const GearIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    p,
  );

// A single block sliced by a gapped cut line: its side walls run from each cap
// down toward the line but stop short of it, leaving the split open. Six short
// dashes radiate from (but don't meet at) the split point (the cursor).
export const SplitIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <path d="M3 9V3.5Q3 2 4.5 2H19.5Q21 2 21 3.5V9" />
      <path d="M3 15V20.5Q3 22 4.5 22H19.5Q21 22 21 20.5V15" />
      <path d="M1 12h6.5" />
      <path d="M16.5 12h6.5" />
      <path d="M12 8.6v0.9" />
      <path d="M12 14.5v0.9" />
      <path d="M9.84 10.75L9.06 10.3" />
      <path d="M14.16 13.25L14.94 13.7" />
      <path d="M14.16 10.75L14.94 10.3" />
      <path d="M9.84 13.25L9.06 13.7" />
    </>,
    p,
  );

// A pin/anchor for the start/duration/end fixedness toggles.
export const AnchorIcon = (p: Props): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 7.5V21" />
      <path d="M5 13a7 7 0 0 0 14 0" />
      <path d="M3 13h4M17 13h4" />
    </>,
    p,
  );
