// Publish errors; pressing one selects the node or edge it is about.
export function ErrorList({ errors, onSelect }) {
  return (
    <div className="publish-errors" role="alert" aria-label="Publish errors">
      <strong>The workflow cannot be published yet:</strong>
      <ul>
        {errors.map((e, i) => {
          const target = e.node ? { kind: 'node', id: e.node } : e.edge ? { kind: 'edge', id: e.edge } : null;
          return (
            <li key={i}>
              {target ? (
                <button type="button" className="link" onClick={() => onSelect(target)}>
                  {e.message}
                </button>
              ) : (
                e.message
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
