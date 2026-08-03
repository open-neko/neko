export type RecordNavObject = {
  apiName: string;
  label: string;
  pluralLabel: string;
  recordCount: string | null;
  custom: boolean;
};

export type RecordNavSection = {
  id: "favorites" | "recent" | "browse" | "search";
  label: string;
  objects: RecordNavObject[];
};

const DEFAULT_OBJECT_LIMIT = 12;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildRecordNavSections(input: {
  objects: RecordNavObject[];
  favorites: string[];
  recents: string[];
  activeObjectApiName?: string | null;
  query?: string;
  expanded?: boolean;
  limit?: number;
}): { sections: RecordNavSection[]; hiddenCount: number } {
  const limit = Math.max(1, input.limit ?? DEFAULT_OBJECT_LIMIT);
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  if (query) {
    const matches = input.objects.filter((object) =>
      [object.label, object.pluralLabel, object.apiName].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
    const visible = input.expanded ? matches : matches.slice(0, limit);
    return {
      sections: visible.length > 0
        ? [{ id: "search", label: "Search results", objects: visible }]
        : [],
      hiddenCount: Math.max(0, matches.length - visible.length),
    };
  }

  const byApiName = new Map(input.objects.map((object) => [object.apiName, object]));
  const favoriteIds = unique(input.favorites).filter((id) => byApiName.has(id));
  const recentIds = unique([
    ...(input.activeObjectApiName ? [input.activeObjectApiName] : []),
    ...input.recents,
  ]).filter((id) => byApiName.has(id) && !favoriteIds.includes(id));
  const claimed = new Set([...favoriteIds, ...recentIds]);
  const browse = input.objects.filter((object) => !claimed.has(object.apiName));
  const visibleBrowse = input.expanded ? browse : browse.slice(0, limit);
  const sections: RecordNavSection[] = [];
  if (favoriteIds.length > 0) {
    sections.push({
      id: "favorites",
      label: "Favorites",
      objects: favoriteIds.map((id) => byApiName.get(id)!),
    });
  }
  if (recentIds.length > 0) {
    sections.push({
      id: "recent",
      label: "Recent",
      objects: recentIds.slice(0, 6).map((id) => byApiName.get(id)!),
    });
  }
  if (visibleBrowse.length > 0) {
    sections.push({ id: "browse", label: "Browse", objects: visibleBrowse });
  }
  return {
    sections,
    hiddenCount: Math.max(0, browse.length - visibleBrowse.length),
  };
}
