import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { LoopName } from "@usine/core/loop";
import type { ItemKey } from "@usine/core/item";
import { splitRepositoryName } from "@usine/core/repository";
import { LoopPreviewRequest } from "@usine/orchestrator/operator/http";
import { Option, type Schema } from "effect";
import { ErrorAlert } from "~/components/error-alert";
import { FillCell } from "~/components/fill-cell";
import { ItemHeading } from "~/components/item/heading";
import { Markdown } from "~/components/markdown";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { loopPreviewQuery } from "~/features/configuration/queries";
import { loopFormCopy } from "~/features/configuration/strings";

type LoopPreviewProps = { readonly name: LoopName; readonly value: Schema.Json };
export const LoopPreview = ({ name, value }: LoopPreviewProps) => {
  const [itemKey, setItemKey] = useState<ItemKey>();
  const input = { name, value };
  const preview = useQuery(
    loopPreviewQuery(new LoopPreviewRequest(itemKey === undefined ? input : { ...input, itemKey })),
  );
  if (preview.isPending) return <p role="status">{loopFormCopy.previewing}</p>;
  if (preview.isError) return <ErrorAlert message={preview.error.message} />;
  const data = preview.data;
  return (
    <section className="min-w-0 space-y-3" aria-label={loopFormCopy.preview}>
      <h3 className="font-semibold" aria-live="polite">
        {loopFormCopy.count(data.total, data.items.length)}
      </h3>
      {data.stream === "schedule" ? (
        <p>{loopFormCopy.schedule}</p>
      ) : (
        data.total === 0 && <p>{loopFormCopy.empty}</p>
      )}
      {data.repositoriesWithoutItems.length > 0 && (
        <p className="text-muted-foreground">
          {loopFormCopy.noData(data.repositoriesWithoutItems)}
        </p>
      )}
      {data.items.length > 0 && (
        <Table>
          <TableBody>
            {data.items.map((item) => {
              const repository = splitRepositoryName(item.repository);
              return (
                <TableRow key={item.itemKey}>
                  <FillCell>
                    <Link
                      to="/projects/$project/$name/tasks/$number"
                      params={{
                        project: repository.owner,
                        name: repository.name,
                        number: String(item.number),
                      }}
                      className="text-primary"
                    >
                      <ItemHeading
                        item={Option.some(item)}
                        title={item.title}
                        variant="row"
                        linked={false}
                      />
                    </Link>
                    <p className="text-xs text-muted-foreground">{item.repository}</p>
                  </FillCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      aria-pressed={data.prompt?.itemKey === item.itemKey}
                      onClick={() => setItemKey(item.itemKey)}
                    >
                      {loopFormCopy.sample}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {data.failures.map((failure, index) => (
        <ErrorAlert key={`${failure.itemKey}:${index}`} message={failure.message} />
      ))}
      {data.prompt !== null && (
        <div className="min-w-0 space-y-2 wrap-anywhere">
          <h3 className="font-semibold">{loopFormCopy.rendered}</h3>
          <Markdown>{data.prompt.text}</Markdown>
        </div>
      )}
    </section>
  );
};
