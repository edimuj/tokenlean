#!/usr/bin/env node

/**
 * tl-completions - Generate shell tab completions for tl
 */

function generateBash() {
  return `# tl (tokenlean) bash completion
# Install: tl completions bash >> ~/.bashrc
#      or: tl completions bash | sudo tee /etc/bash_completion.d/tl

_tl() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    local cmd="\${COMP_WORDS[1]}"

    # Subcommand completion
    if [[ \$COMP_CWORD -eq 1 ]]; then
        COMPREPLY=(\$(compgen -W "\$(tl --list-commands 2>/dev/null)" -- "\$cur"))
        return
    fi

    # Flag completion
    if [[ "\$cur" == -* ]]; then
        COMPREPLY=(\$(compgen -W "\$(tl --list-flags "\$cmd" 2>/dev/null)" -- "\$cur"))
        return
    fi

    # Subcommand-specific positional args
    case "\$cmd" in
        completions)
            COMPREPLY=(\$(compgen -W "bash zsh" -- "\$cur"))
            return
            ;;
        cache)
            COMPREPLY=(\$(compgen -W "stats clear clear-all" -- "\$cur"))
            return
            ;;
        hook)
            if [[ \$COMP_CWORD -eq 2 ]]; then
                COMPREPLY=(\$(compgen -W "run install uninstall status" -- "\$cur"))
                return
            fi
            ;;
        gh)
            if [[ \$COMP_CWORD -eq 2 ]]; then
                COMPREPLY=(\$(compgen -W "issue pr project release" -- "\$cur"))
                return
            elif [[ \$COMP_CWORD -eq 3 ]]; then
                case "\${COMP_WORDS[2]}" in
                    issue) COMPREPLY=(\$(compgen -W "view create-batch create-tree add-sub close-batch label-batch" -- "\$cur")) ;;
                    pr) COMPREPLY=(\$(compgen -W "digest comments land" -- "\$cur")) ;;
                    project) COMPREPLY=(\$(compgen -W "add-batch" -- "\$cur")) ;;
                    release) COMPREPLY=(\$(compgen -W "notes" -- "\$cur")) ;;
                esac
                return
            fi
            ;;
    esac

    # Default: file completion (via -o default)
}

complete -o default -F _tl tl
`;
}

function generateZsh() {
  return `#compdef tl
# tl (tokenlean) zsh completion
# Install: tl completions zsh > "\${fpath[1]}/_tl" && compinit
#      or: tl completions zsh >> ~/.zshrc

_tl() {
    local -a commands

    if (( CURRENT == 2 )); then
        local name desc
        while IFS=$'\\t' read -r name desc; do
            commands+=("\${name}:\${desc}")
        done < <(tl --list-commands --with-desc 2>/dev/null)
        _describe 'command' commands
        return
    fi

    local cmd="\$words[2]"

    if [[ "\$PREFIX" == -* ]]; then
        local -a flags
        flags=(\${(f)"\$(tl --list-flags "\$cmd" 2>/dev/null)"})
        compadd -a flags
        return
    fi

    case "\$cmd" in
        completions)
            _describe 'shell' '(bash:"Bash completion script" zsh:"Zsh completion script")'
            return
            ;;
        cache)
            _describe 'action' '(stats:"Show cache statistics" clear:"Clear project cache" clear-all:"Clear entire cache")'
            return
            ;;
        hook)
            if (( CURRENT == 3 )); then
                _describe 'action' '(run:"Run hook" install:"Install hooks" uninstall:"Remove hooks" status:"Show hook status")'
                return
            fi
            ;;
        gh)
            if (( CURRENT == 3 )); then
                _describe 'resource' '(issue:"Issue operations" pr:"Pull request operations" project:"Project board" release:"Release operations")'
                return
            elif (( CURRENT == 4 )); then
                case "\$words[3]" in
                    issue) _describe 'action' '(view create-batch create-tree add-sub close-batch label-batch)' ;;
                    pr) _describe 'action' '(digest comments land)' ;;
                    project) _describe 'action' '(add-batch)' ;;
                    release) _describe 'action' '(notes)' ;;
                esac
                return
            fi
            ;;
    esac

    _files
}

compdef _tl tl
`;
}

function printHelp() {
  console.log(`tl-completions - Generate shell tab completions for tl

Usage: tl completions <shell>

Shells:
  bash    Bash completion script
  zsh     Zsh completion script

Install (bash):
  tl completions bash >> ~/.bashrc
  source ~/.bashrc

Install (zsh):
  tl completions zsh > "\${fpath[1]}/_tl" && compinit

Then type: tl <TAB>`);
}

const [shell] = process.argv.slice(2);

if (!shell || shell === '-h' || shell === '--help') {
  printHelp();
  process.exit(shell ? 0 : 1);
}

const generators = { bash: generateBash, zsh: generateZsh };
const generator = generators[shell];

if (!generator) {
  console.error(`Unknown shell: ${shell}`);
  console.error('Supported: bash, zsh');
  process.exit(1);
}

process.stdout.write(generator());
