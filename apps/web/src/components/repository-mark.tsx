import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { cn } from "~/lib/utils";

/** Rendered width in pixels; the image is fetched at twice this for high-density screens. */
const pixels = { inline: 16, title: 20 } as const;

/** Returns the first letter or digit of `name`, uppercased, so `.github` gives `G`. */
const monogram = (name: string) => (/[a-z0-9]/iu.exec(name)?.[0] ?? name.charAt(0)).toUpperCase();

type RepositoryMarkProps = {
  readonly repository: RepositoryName;
  /** `inline` is 16px, beside 13px text; `title` is 20px, beside a 20px heading. */
  readonly size?: keyof typeof pixels;
};

/**
 * Renders a repository's mark: the owner's GitHub avatar as a square tile, since GitHub has no
 * per-repository image, so repositories with one owner share it. If the image doesn't load, the
 * tile shows the repository name's first letter. Hidden from assistive technology; the name
 * beside the mark is the accessible name.
 */
export const RepositoryMark = ({ repository, size = "inline" }: RepositoryMarkProps) => {
  const { owner, name } = splitRepositoryName(repository);
  return (
    <Avatar
      aria-hidden="true"
      className={cn(
        "rounded-sm bg-accent after:rounded-sm",
        size === "title" ? "size-5" : "size-4",
      )}
    >
      <AvatarImage
        src={`https://github.com/${owner}.png?size=${pixels[size] * 2}`}
        alt=""
        referrerPolicy="no-referrer"
        className="rounded-sm"
      />
      {/* The delay keeps the letter from flashing while an uncached image loads. */}
      <AvatarFallback
        delay={600}
        className="rounded-sm bg-accent text-xs font-semibold text-foreground"
      >
        {monogram(name)}
      </AvatarFallback>
    </Avatar>
  );
};
