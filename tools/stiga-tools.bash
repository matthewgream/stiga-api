#!/bin/bash
# Auto-generated Bash completion for Stiga tools
# Generated on: $(date -Iseconds)

_stiga_analyse_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    local commands="battery-charging battery-consumption garden-completion position-heatmap"
    local global_opts="--database= --mac_device= --help"
    case "${prev}" in
        --database)
            # File completion for database files
            COMPREPLY=( $(compgen -f -X '!*.db' -- "${cur}") )
            return 0
            ;;
        --mac_device)
            # Default MAC address
            COMPREPLY=( "D0:EF:76:64:32:BA" )
            return 0
            ;;
    esac
    if [[ ${cur} == --* ]]; then
        COMPREPLY=( $(compgen -W "${global_opts}" -- ${cur}) )
        return 0
    fi
    local has_command=false
    for word in "${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
        if [[ " ${commands} " =~ " ${word} " ]]; then
            has_command=true
            break
        fi
    done
    if [[ ${has_command} == false ]]; then
        COMPREPLY=( $(compgen -W "${commands}" -- ${cur}) )
    fi
}

_stiga_command_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    local commands="version status schedule start stop go-home home calibrate-blades blades info describe check"
    local global_opts="--robot --base --both --debug --level --format --watch --passive --username --password --help"
    local levels="quiet normal verbose"
    local formats="text json none"
    local schedule_subcmds="enable disable insert add remove"
    local robot_status_types="operation battery mowing location network"
    local base_status_types="operation location network"
    case "${prev}" in
        --level)
            COMPREPLY=( $(compgen -W "${levels}" -- "${cur}") )
            return 0
            ;;
        --format)
            COMPREPLY=( $(compgen -W "${formats}" -- "${cur}") )
            return 0
            ;;
        --watch)
            COMPREPLY=( $(compgen -W "0 5 10 30 60" -- "${cur}") )
            return 0
            ;;
        --username|--password)
            return 0
            ;;
    esac
    local current_command=""
    local has_target=false
    for ((i=1; i<COMP_CWORD; i++)); do
        case "${COMP_WORDS[i]}" in
            --robot|--base|--both)
                has_target=true
                ;;
            version|status|schedule|start|stop|go-home|home|calibrate-blades|blades|info|describe|check)
                current_command="${COMP_WORDS[i]}"
                break
                ;;
        esac
    done
    case "${current_command}" in
        schedule)
            local has_subcommand=false
            for ((i=2; i<COMP_CWORD; i++)); do
                if [[ " ${schedule_subcmds} " =~ " ${COMP_WORDS[i]} " ]]; then
                    has_subcommand=true
                    break
                fi
            done
            if [[ ${has_subcommand} == false ]] && [[ ${cur} != --* ]]; then
                COMPREPLY=( $(compgen -W "${schedule_subcmds} help" -- ${cur}) )
                return 0
            fi
            ;;
        status)
            if [[ ${prev} == "status" ]] && [[ ${cur} != --* ]]; then
                local status_types=""
                for ((i=1; i<COMP_CWORD; i++)); do
                    case "${COMP_WORDS[i]}" in
                        --robot)
                            status_types="${robot_status_types}"
                            break
                            ;;
                        --base)
                            status_types="${base_status_types}"
                            break
                            ;;
                        --both|*)
                            status_types="${robot_status_types}"
                            ;;
                    esac
                done
                COMPREPLY=( $(compgen -W "${status_types} help" -- ${cur}) )
                return 0
            fi
            ;;
        start|stop|go-home|home|calibrate-blades|blades|info|describe|check|version)
            if [[ ${cur} != --* ]]; then
                COMPREPLY=( $(compgen -W "help" -- ${cur}) )
                return 0
            fi
            ;;
    esac
    if [[ ${cur} == --* ]]; then
        COMPREPLY=( $(compgen -W "${global_opts}" -- ${cur}) )
        return 0
    fi
    if [[ -z ${current_command} ]]; then
        COMPREPLY=( $(compgen -W "${commands}" -- ${cur}) )
    fi
}

_stiga_exporter_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    local opts="--format --output --credentials --sheet-name --mac_device= --mac_base= --start --end --head --tail --stats --verbose --help"
    local formats="log csv sheets"
    case "${prev}" in
        --format)
            COMPREPLY=( $(compgen -W "${formats}" -- "${cur}") )
            return 0
            ;;
        --output|--credentials)
            COMPREPLY=( $(compgen -f -- "${cur}") )
            return 0
            ;;
        --mac_device)
            COMPREPLY=( "D0:EF:76:64:32:BA" )
            return 0
            ;;
        --mac_base)
            COMPREPLY=( "FC:E8:C0:72:EC:62" )
            return 0
            ;;
        --start|--end)
            COMPREPLY=( "$(date -Iseconds)" )
            return 0
            ;;
    esac
    if [[ ${cur} == --* ]]; then
        COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
        return 0
    fi
    local has_db=false
    for ((i=1; i<COMP_CWORD; i++)); do
        if [[ "${COMP_WORDS[i]}" != --* ]] && [[ "${COMP_WORDS[i-1]}" != --* ]]; then
            has_db=true
            break
        fi
    done
    if [[ ${has_db} == false ]]; then
        # Database file completion
        COMPREPLY=( $(compgen -f -X '!*.db' -- "${cur}") )
    fi
}

_stiga_monitor_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    local opts="--connect --background --monitor --capture --listen --intercept --directory= --mac_device= --mac_base= --location_lat= --location_lon= --timing-levels-docked= --timing-levels-undocked= --help"
    case "${prev}" in
        --directory)
            COMPREPLY=( $(compgen -d -- "${cur}") )
            return 0
            ;;
        --capture)
            COMPREPLY=( $(compgen -f -X '!*.db' -- "${cur}") )
            return 0
            ;;
        --listen)
            COMPREPLY=( $(compgen -f -X '!*.log' -- "${cur}") )
            return 0
            ;;
        --intercept)
            COMPREPLY=( "8083" )
            return 0
            ;;
        --mac_device)
            COMPREPLY=( "D0:EF:76:64:32:BA" )
            return 0
            ;;
        --mac_base)
            COMPREPLY=( "FC:E8:C0:72:EC:62" )
            return 0
            ;;
        --location_lat)
            COMPREPLY=( "59.661923" )
            return 0
            ;;
        --location_lon)
            COMPREPLY=( "12.996271" )
            return 0
            ;;
        --timing-levels-docked|--timing-levels-undocked)
            COMPREPLY=( "status:30s,version:60m,settings:30m" )
            return 0
            ;;
    esac
    if [[ ${cur} == --* ]]; then
        COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
        return 0
    fi
}

complete -F _stiga_analyse_completion stiga-analyse.js
complete -F _stiga_command_completion stiga-command.js
complete -F _stiga_exporter_completion stiga-exporter.js
complete -F _stiga_monitor_completion stiga-monitor.js

complete -F _stiga_analyse_completion ./stiga-analyse.js
complete -F _stiga_command_completion ./stiga-command.js
complete -F _stiga_exporter_completion ./stiga-exporter.js
complete -F _stiga_monitor_completion ./stiga-monitor.js

