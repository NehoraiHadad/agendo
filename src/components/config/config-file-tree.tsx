'use client';

import { useState } from 'react';
import { FileText, Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  /**
   * Tokens loaded on every message.
   * - Regular files: full content.
   * - skills/ and commands/ files: frontmatter only.
   * - Directories: sum of all descendant always-loaded tokens.
   */
  tokenEstimate?: number;
  /**
   * Body tokens loaded only when the skill/command is invoked.
   * Only present for files inside skills/ or commands/ directories.
   */
  invokeTokenEstimate?: number;
  children?: TreeNode[];
}

interface ConfigFileTreeProps {
  tree: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface TreeNodeItemProps {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth: number;
  autoExpand: boolean;
}

/** Returns true if `selectedPath` lives anywhere under `node`. */
function containsSelected(node: TreeNode, selectedPath: string | null): boolean {
  if (!selectedPath) return false;
  if (!node.isDirectory) return node.path === selectedPath;
  if (!node.children) return false;
  return node.children.some((child) => containsSelected(child, selectedPath));
}

function fmtTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1)}K`;
}

function TreeNodeItem({ node, selectedPath, onSelect, depth, autoExpand }: TreeNodeItemProps) {
  const [isManuallyToggled, setIsManuallyToggled] = useState(false);
  const [manualState, setManualState] = useState(false);

  // Derive open state: manual toggle wins, otherwise auto-expand when a child is selected.
  const isOpen = isManuallyToggled ? manualState : autoExpand;

  const indent = depth * 16;
  const isSelected = !node.isDirectory && node.path === selectedPath;
  const hasSelectedChild = node.isDirectory && containsSelected(node, selectedPath);

  function handleToggle() {
    setIsManuallyToggled(true);
    setManualState(!isOpen);
  }

  if (node.isDirectory) {
    const FolderIcon = isOpen ? FolderOpen : Folder;
    const ChevronIcon = isOpen ? ChevronDown : ChevronRight;

    return (
      <div>
        <button
          type="button"
          onClick={handleToggle}
          className={cn(
            'w-full flex items-center gap-1.5 py-1 px-2 rounded-md text-left transition-colors',
            'text-[11px] font-medium',
            'hover:bg-white/[0.04]',
            hasSelectedChild
              ? 'text-foreground/80'
              : 'text-muted-foreground/50 hover:text-muted-foreground/80',
          )}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          <ChevronIcon className="h-3 w-3 shrink-0 text-muted-foreground/30" />
          <FolderIcon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              hasSelectedChild ? 'text-amber-400/70' : 'text-muted-foreground/35',
            )}
          />
          <span className="truncate flex-1">{node.name}</span>
          {node.tokenEstimate !== undefined && node.tokenEstimate > 0 && (
            <span
              className="text-[10px] font-mono shrink-0 ml-1"
              style={{ color: 'oklch(0.55 0 0 / 0.5)' }}
              title={`~${node.tokenEstimate} tokens always loaded across all files in this directory`}
            >
              {fmtTokens(node.tokenEstimate)}
            </span>
          )}
        </button>
        {isOpen && node.children && node.children.length > 0 && (
          <div>
            {node.children.map((child) => (
              <TreeNodeItem
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
                autoExpand={containsSelected(child, selectedPath)}
              />
            ))}
          </div>
        )}
        {isOpen && (!node.children || node.children.length === 0) && (
          <div
            className="py-1 text-[10px] text-muted-foreground/20 italic"
            style={{ paddingLeft: `${indent + 32}px` }}
          >
            empty
          </div>
        )}
      </div>
    );
  }

  // File node
  const hasInvokeBody = node.invokeTokenEstimate !== undefined && node.invokeTokenEstimate > 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={cn(
        'w-full flex items-center gap-1.5 py-1 px-2 rounded-md text-left transition-all duration-100',
        'text-[11px]',
        isSelected
          ? 'bg-primary/[0.12] text-primary font-medium'
          : 'text-muted-foreground/55 hover:text-foreground/80 hover:bg-white/[0.04]',
      )}
      style={{ paddingLeft: `${indent + 8}px` }}
    >
      {isSelected ? (
        <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30" />
      )}
      <span className="truncate flex-1">{node.name}</span>

      {/* Token count badge */}
      {node.tokenEstimate !== undefined && (
        <span
          className="text-[10px] font-mono shrink-0 ml-1 flex items-center gap-0.5"
          style={{
            color: isSelected ? 'oklch(0.65 0.18 280 / 0.6)' : 'oklch(0.5 0 0 / 0.45)',
          }}
          title={
            hasInvokeBody
              ? `Frontmatter: ~${node.tokenEstimate} tokens (loaded every message) · Body: ~${node.invokeTokenEstimate} tokens (loaded on invoke only)`
              : `~${node.tokenEstimate} tokens — loaded by Claude every session`
          }
        >
          {fmtTokens(node.tokenEstimate)}
          {hasInvokeBody && node.invokeTokenEstimate !== undefined && (
            <span style={{ color: 'oklch(0.45 0 0 / 0.35)' }}>
              {' '}
              +{fmtTokens(node.invokeTokenEstimate)}↗
            </span>
          )}
        </span>
      )}
    </button>
  );
}

export function ConfigFileTree({ tree, selectedPath, onSelect }: ConfigFileTreeProps) {
  if (tree.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <p className="text-[11px] text-muted-foreground/30 italic">No config files found</p>
      </div>
    );
  }

  return (
    <div className="py-1 space-y-0.5">
      {tree.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={0}
          autoExpand={containsSelected(node, selectedPath)}
        />
      ))}
    </div>
  );
}
