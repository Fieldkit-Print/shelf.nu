/** Small helper that appends `Fieldkit` to the current route meta title */
export const appendToMetaTitle = (title: string | null | undefined) =>
  `${title ? title : "Not found"} | Fieldkit`;
