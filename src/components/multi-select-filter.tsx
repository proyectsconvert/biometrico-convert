import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export type MultiSelectOption = {
  value: string;
  label: string;
  sublabel?: string | null;
};

export interface MultiSelectFilterProps {
  title: string;
  placeholder?: string;
  searchPlaceholder?: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  className?: string;
  triggerClassName?: string;
  popoverWidth?: string;
}

export function MultiSelectFilter({
  title,
  placeholder,
  searchPlaceholder = "Buscar...",
  options,
  selected,
  onChange,
  className,
  triggerClassName,
  popoverWidth = "w-[300px]",
}: MultiSelectFilterProps) {
  const [open, setOpen] = React.useState(false);

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const toggleOption = (val: string) => {
    if (selectedSet.has(val)) {
      onChange(selected.filter((v) => v !== val));
    } else {
      onChange([...selected, val]);
    }
  };

  const removeOption = (e: React.MouseEvent, val: string) => {
    e.stopPropagation();
    onChange(selected.filter((v) => v !== val));
  };

  const clearAll = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onChange([]);
  };

  // Encontrar nombres de seleccionados para etiquetas
  const selectedOptions = React.useMemo(() => {
    return options.filter((o) => selectedSet.has(o.value));
  }, [options, selectedSet]);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn("h-9 min-w-[190px] justify-between px-3 text-left font-normal", triggerClassName)}
          >
            <div className="flex items-center gap-1.5 truncate">
              {selected.length === 0 ? (
                <span className="text-muted-foreground">{placeholder || `Todos (${title})`}</span>
              ) : selected.length === 1 ? (
                <span className="truncate font-medium">{selectedOptions[0]?.label || selected[0]}</span>
              ) : (
                <div className="flex items-center gap-1.5 truncate">
                  <span className="font-medium text-foreground">{title}:</span>
                  <Badge variant="secondary" className="h-5 rounded px-1 text-xs font-semibold">
                    {selected.length} seleccionados
                  </Badge>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              {selected.length > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={clearAll}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Limpiar selección"
                >
                  <X className="size-3.5" />
                </span>
              )}
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
            </div>
          </Button>
        </PopoverTrigger>
        <PopoverContent className={cn("p-0 shadow-lg", popoverWidth)} align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList className="max-h-64">
              <CommandEmpty>No se encontraron resultados.</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const isSelected = selectedSet.has(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={`${option.label} ${option.sublabel || ""} ${option.value}`}
                      onSelect={() => toggleOption(option.value)}
                      className="cursor-pointer"
                    >
                      <div
                        className={cn(
                          "mr-2 flex size-4 items-center justify-center rounded-sm border border-primary",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "opacity-50 [&_svg]:invisible",
                        )}
                      >
                        <Check className="size-3" />
                      </div>
                      <div className="flex flex-col truncate">
                        <span className="truncate text-xs font-medium">{option.label}</span>
                        {option.sublabel && (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {option.sublabel}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {selected.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => clearAll()}
                      className="cursor-pointer justify-center text-center text-xs text-destructive hover:bg-destructive/10"
                    >
                      Limpiar {selected.length} selección(es)
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Chips rápidos si hay 1 a 3 elementos seleccionados */}
      {selected.length > 0 && selected.length <= 4 && (
        <div className="flex flex-wrap gap-1">
          {selectedOptions.map((opt) => (
            <Badge
              key={opt.value}
              variant="secondary"
              className="h-5 gap-1 px-1.5 text-[11px] font-normal"
            >
              <span className="max-w-[120px] truncate">{opt.label}</span>
              <button
                type="button"
                onClick={(e) => removeOption(e, opt.value)}
                className="hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
