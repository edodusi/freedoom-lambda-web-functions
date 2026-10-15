#!/usr/bin/env bash
# Builds server/doom.wasm from vendor/doomgeneric plus engine/doomgeneric_wasi.c.
# Needs zig (used only as a clang + WASI libc toolchain). Override with ZIG=/path/to/zig.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SRC="$ROOT/vendor/doomgeneric/doomgeneric"
OUT="$ROOT/server/doom.wasm"
ZIG="${ZIG:-zig}"

if [ ! -d "$SRC" ]; then
  echo "Missing $SRC. Run: git clone --depth 1 https://github.com/ozkl/doomgeneric.git vendor/doomgeneric" >&2
  exit 1
fi

# Same source list as doomgeneric's Makefile, minus the X11 platform file.
FILES="dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net
f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system
i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng
p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup
p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main r_plane r_segs r_sky
r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file
w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric"

SOURCES=()
for f in $FILES; do SOURCES+=("$SRC/$f.c"); done

"$ZIG" cc -target wasm32-wasi -mexec-model=reactor -O2 \
  -DCMAP256 -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -Wno-everything \
  -I"$SRC" \
  "${SOURCES[@]}" "$HERE/doomgeneric_wasi.c" \
  -o "$OUT"

ls -l "$OUT"
