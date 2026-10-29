import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";

export type PageCommand = { readonly label: string; readonly run: () => void };
type RegisteredCommand = PageCommand & { readonly id: string };
type RegisterCommands = (id: string, commands: ReadonlyArray<PageCommand>) => () => void;

const RegisterContext = createContext<RegisterCommands>(() => () => {});
export const PageCommandsContext = createContext<ReadonlyArray<RegisteredCommand>>([]);

type PageCommandsProviderProps = { readonly children: ReactNode };

export const PageCommandsProvider = ({ children }: PageCommandsProviderProps) => {
  const [groups, setGroups] = useState<ReadonlyMap<string, ReadonlyArray<PageCommand>>>(new Map());
  const register = useCallback<RegisterCommands>((id, commands) => {
    setGroups((current) => new Map(current).set(id, commands));
    return () =>
      setGroups((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
  }, []);
  const commands = [...groups].flatMap(([id, entries]) =>
    entries.map((command) => ({
      ...command,
      id: `${id}:${command.label}`,
    })),
  );
  return (
    <RegisterContext value={register}>
      <PageCommandsContext value={commands}>{children}</PageCommandsContext>
    </RegisterContext>
  );
};

/** Registers only actions currently available; removes them when the page or control unmounts. */
export const usePageCommands = (commands: ReadonlyArray<PageCommand>) => {
  const id = useId();
  const register = useContext(RegisterContext);
  useEffect(() => register(id, commands), [register, id, commands]);
};
