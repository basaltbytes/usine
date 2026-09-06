import { createContext, useContext, useReducer, useCallback, type ReactNode } from "react";

interface Disclosure {
  readonly open: boolean;
  readonly groupOpen: boolean;
}

/** Reader choices attach to durable row identities, independently of current grouping or filters. */
export type TranscriptDisclosure = ReadonlyMap<string, Disclosure>;

type DisclosureChange =
  | { readonly _tag: "Item"; readonly key: string; readonly open: boolean }
  | { readonly _tag: "Group"; readonly keys: ReadonlyArray<string>; readonly open: boolean };

/** Applies an explicit reader choice without discarding the choices of hidden group members. */
export const changeDisclosure = (
  previous: TranscriptDisclosure,
  change: DisclosureChange,
): TranscriptDisclosure => {
  const next = new Map(previous);
  if (change._tag === "Item") {
    const existing = previous.get(change.key);
    next.delete(change.key);
    next.set(change.key, {
      open: change.open,
      groupOpen: change.open || existing?.groupOpen === true,
    });
  } else {
    for (const key of change.keys) {
      next.delete(key);
      next.set(key, { open: previous.get(key)?.open === true, groupOpen: change.open });
    }
  }
  return next;
};

/** A group remains exposed when an inspected running call finishes or older members arrive. */
export const isGroupOpen = (state: TranscriptDisclosure, keys: ReadonlyArray<string>): boolean =>
  keys.some((key) => state.get(key)?.groupOpen === true);

const DisclosureContext = createContext<{
  readonly state: TranscriptDisclosure;
  readonly change: (change: DisclosureChange) => void;
  readonly reveal: (change: DisclosureChange) => void;
} | null>(null);

/** Keep outside the scroller's filter key so reader choices survive filtering and regrouping. */
export const TranscriptDisclosureProvider = ({
  children,
  initialState = new Map<string, Disclosure>(),
  onInspect,
}: {
  readonly children: ReactNode;
  readonly initialState?: TranscriptDisclosure;
  readonly onInspect?: () => void;
}) => {
  const [state, reveal] = useReducer(changeDisclosure, initialState);
  const change = useCallback(
    (choice: DisclosureChange) => {
      if (choice.open) onInspect?.();
      reveal(choice);
    },
    [onInspect],
  );
  return (
    <DisclosureContext.Provider value={{ state, change, reveal }}>
      {children}
    </DisclosureContext.Provider>
  );
};

/** Shared disclosure state for transcript rows, tool groups and child sessions. */
export const useTranscriptDisclosure = () => {
  const context = useContext(DisclosureContext);
  if (context === null) throw new Error("TranscriptDisclosureProvider is required");
  return context;
};
