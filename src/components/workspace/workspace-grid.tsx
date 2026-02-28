interface WorkspaceGridProps {
  gridCols: 2 | 3;
  children: React.ReactNode;
}

export function WorkspaceGrid({ gridCols, children }: WorkspaceGridProps) {
  return (
    <div
      className="grid gap-3 w-full"
      style={{
        gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
