type PageHeadingProps = {
  eyebrow: React.ReactNode;
  title: string;
  description?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
};

export default function PageHeading({
  eyebrow,
  title,
  description,
  meta,
  actions,
}: PageHeadingProps) {
  return (
    <header className="page-heading">
      <div className="page-heading-copy">
        <div className="page-heading-eyebrow">
          <span className="page-heading-mark" aria-hidden="true" />
          {eyebrow}
          {meta ? <span className="page-heading-meta">{meta}</span> : null}
        </div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-heading-actions">{actions}</div> : null}
    </header>
  );
}
