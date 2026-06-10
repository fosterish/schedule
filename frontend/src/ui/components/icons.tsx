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
