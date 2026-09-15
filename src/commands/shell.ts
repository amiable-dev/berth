import type { ParsedArgs } from '../args.js';
import type { IO } from './query.js';

const NOTE =
  'A one-off shell still works with the plain eval "$(berth env --shell)" — this wraps the same command with a cd-aware hook.';

/**
 * zsh: a chpwd_functions hook. Climbs from $PWD to the nearest ancestor with a `.git` (file or
 * directory — a worktree's .git is a file) using only the `:h` path modifier, never a subprocess.
 * When that root changes, runs `berth env --shell` (entering, or moving into an unregistered
 * directory, which is quiet) or `berth env --shell --unset` for the root just left (leaving).
 * Runs once at source time for the initial cwd.
 */
function zshSnippet(): string {
  return `# berth shell-init (zsh) — cd-aware port exports.
# ${NOTE}
# Add to ~/.zshrc:  eval "$(berth shell-init zsh)"
typeset -g _berth_last_root=""
typeset -g _berth_root=""

_berth_find_root() {
  local dir="$PWD"
  _berth_root=""
  while true; do
    if [[ -e "$dir/.git" ]]; then
      _berth_root="$dir"
      return
    fi
    [[ "$dir" == "/" ]] && return
    dir="\${dir:h}"
  done
}

_berth_chpwd() {
  _berth_find_root
  local root="$_berth_root"
  [[ "$root" == "$_berth_last_root" ]] && return
  if [[ -n "$root" ]]; then
    eval "$(berth env --shell --cwd "$root")"
  elif [[ -n "$_berth_last_root" ]]; then
    eval "$(berth env --shell --unset --cwd "$_berth_last_root")"
  fi
  _berth_last_root="$root"
}

typeset -ga chpwd_functions
if [[ -z "\${chpwd_functions[(r)_berth_chpwd]}" ]]; then
  chpwd_functions+=(_berth_chpwd)
fi
_berth_chpwd`;
}

/**
 * bash: the same idea via PROMPT_COMMAND (bash has no chpwd hook). The ancestor walk uses only
 * `${dir%/*}` parameter expansion, never a subprocess; PROMPT_COMMAND runs before every prompt,
 * but berth is invoked only when the computed root actually changed.
 */
function bashSnippet(): string {
  return `# berth shell-init (bash) — cd-aware port exports.
# ${NOTE}
# Add to ~/.bashrc:  eval "$(berth shell-init bash)"
_berth_last_root=""
_berth_root=""

_berth_find_root() {
  local dir="$PWD"
  _berth_root=""
  while :; do
    if [[ -e "$dir/.git" ]]; then
      _berth_root="$dir"
      return
    fi
    if [[ "$dir" == "/" ]]; then
      return
    fi
    dir="\${dir%/*}"
    if [[ -z "$dir" ]]; then
      dir="/"
    fi
  done
}

_berth_chpwd() {
  _berth_find_root
  local root="$_berth_root"
  if [[ "$root" == "$_berth_last_root" ]]; then
    return
  fi
  if [[ -n "$root" ]]; then
    eval "$(berth env --shell --cwd "$root")"
  elif [[ -n "$_berth_last_root" ]]; then
    eval "$(berth env --shell --unset --cwd "$_berth_last_root")"
  fi
  _berth_last_root="$root"
}

case ";\${PROMPT_COMMAND:-};" in
  *";_berth_chpwd;"*) ;;
  *) PROMPT_COMMAND="_berth_chpwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
_berth_chpwd`;
}

/**
 * fish: a function on `--on-variable PWD` (fish has no `export`/`unset`/`eval "$(...)"` the way
 * POSIX shells do, so this parses berth's `--shell` export/unset lines itself and applies them
 * with `set -gx` / `set -e`). The ancestor walk uses `string replace -r`, never a subprocess.
 */
function fishSnippet(): string {
  return `# berth shell-init (fish) — cd-aware port exports.
# ${NOTE}
# Add to ~/.config/fish/config.fish:  berth shell-init fish | source
set -g _berth_last_root ""
set -g _berth_root ""

function _berth_find_root
    set -l dir $PWD
    set -g _berth_root ""
    while true
        if test -e "$dir/.git"
            set -g _berth_root $dir
            return
        end
        if test "$dir" = "/"
            return
        end
        set dir (string replace -r -- '/[^/]*$' '' $dir)
        if test -z "$dir"
            set dir "/"
        end
    end
end

function _berth_export_line -a line
    if string match -q -- 'export *' $line
        set -l kv (string sub -s 8 -- $line)
        set -l parts (string split -m 1 -- '=' $kv)
        set -gx $parts[1] (string trim -c "'" -- $parts[2])
    end
end

function _berth_unset_line -a line
    if string match -q -- 'unset *' $line
        set -e (string sub -s 7 -- $line)
    end
end

function _berth_chpwd --on-variable PWD
    _berth_find_root
    set -l root $_berth_root
    if test "$root" = "$_berth_last_root"
        return
    end
    if test -n "$root"
        for line in (berth env --shell --cwd $root)
            _berth_export_line $line
        end
    else if test -n "$_berth_last_root"
        for line in (berth env --shell --unset --cwd $_berth_last_root)
            _berth_unset_line $line
        end
    end
    set -g _berth_last_root $root
end

_berth_chpwd`;
}

const SNIPPETS: Record<string, () => string> = {
  zsh: zshSnippet,
  bash: bashSnippet,
  fish: fishSnippet,
};

export async function cmdShellInit(args: ParsedArgs, io: IO): Promise<number> {
  const shell = args.positional[0];
  const build = shell ? SNIPPETS[shell] : undefined;
  if (!build) {
    io.err(`berth: unknown shell "${shell ?? ''}" for shell-init; supported: zsh, bash, fish`);
    return 2;
  }
  io.out(build());
  return 0;
}
