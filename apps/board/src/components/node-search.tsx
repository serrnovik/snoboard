import { useCallback, useState } from "react";

import {
  useReactFlow,
  type BuiltInEdge,
  type Node,
  type PanelProps,
} from "@xyflow/react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface NodeSearchProps extends Omit<PanelProps, "children"> {
  // The function to search for nodes, should return an array of nodes that match the search string
  // By default, it will check for lowercase string inclusion.
  onSearch?: (searchString: string) => Node[];
  // The function to select a node, should set the node as selected and fit the view to the node
  // By default, it will set the node as selected and fit the view to the node.
  onSelectNode?: (node: Node) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function nodeSearchLabel(node: Node): string {
  const label = node.data.label;
  if (typeof label === "string" && label.length > 0) return label;
  return node.id;
}

export function NodeSearchInternal({
  onSearch,
  onSelectNode,
  open,
  onOpenChange,
}: NodeSearchProps) {
  const [searchResults, setSearchResults] = useState<Node[]>([]);
  const [searchString, setSearchString] = useState<string>("");
  const { getNodes, fitView, setNodes } = useReactFlow<Node, BuiltInEdge>();

  const defaultOnSearch = useCallback(
    (query: string) => {
      const nodes = getNodes();
      const normalizedQuery = query.toLowerCase();
      return nodes.filter((node) => {
        const label = node.data.label;
        if (typeof label !== "string") return false;
        return label.toLowerCase().includes(normalizedQuery);
      });
    },
    [getNodes],
  );

  const onChange = useCallback(
    (query: string) => {
      setSearchString(query);
      const queryIsEmpty = query.length === 0;
      if (queryIsEmpty) {
        setSearchResults([]);
        onOpenChange?.(false);
        return;
      }
      onOpenChange?.(true);
      const search = onSearch ?? defaultOnSearch;
      setSearchResults(search(query));
    },
    [defaultOnSearch, onOpenChange, onSearch],
  );

  const defaultOnSelectNode = useCallback(
    (node: Node) => {
      setNodes((nodes) =>
        nodes.map((n) => (n.id === node.id ? { ...n, selected: true } : n)),
      );
      fitView({ nodes: [node], duration: 500 });
    },
    [fitView, setNodes],
  );

  const onSelect = useCallback(
    (node: Node) => {
      (onSelectNode || defaultOnSelectNode)?.(node);
      setSearchString("");
      onOpenChange?.(false);
    },
    [onSelectNode, defaultOnSelectNode, onOpenChange],
  );

  return (
    <>
      <CommandInput
        placeholder="Search nodes..."
        onValueChange={onChange}
        value={searchString}
        onFocus={() => onOpenChange?.(true)}
      />

      {open && (
        <CommandList>
          {searchResults.length === 0 ? (
            <CommandEmpty>No results found. {searchString}</CommandEmpty>
          ) : (
            <CommandGroup heading="Nodes">
              {searchResults.map((node) => {
                return (
                  <CommandItem key={node.id} value={node.id} onSelect={() => onSelect(node)}>
                    <span>{nodeSearchLabel(node)}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      )}
    </>
  );
}

export function NodeSearch({
  className,
  onSearch,
  onSelectNode,
  ...props
}: NodeSearchProps) {
  const [open, setOpen] = useState(false);
  return (
    <Command
      shouldFilter={false}
      className="w-72 max-w-full rounded-lg border bg-popover text-popover-foreground shadow-md"
    >
      <NodeSearchInternal
        className={className}
        onSearch={onSearch}
        onSelectNode={onSelectNode}
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </Command>
  );
}

export interface NodeSearchDialogProps extends NodeSearchProps {
  title?: string;
}

export function NodeSearchDialog({
  className,
  onSearch,
  onSelectNode,
  open,
  onOpenChange,
  ...props
}: NodeSearchDialogProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <NodeSearchInternal
        className={className}
        onSearch={onSearch}
        onSelectNode={onSelectNode}
        open={open}
        onOpenChange={onOpenChange}
        {...props}
      />
    </CommandDialog>
  );
}
