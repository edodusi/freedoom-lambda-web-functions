// doomgeneric platform layer for a headless WASI build driven from Node.js.
//
// The host (server/engine.js) owns time and input:
//   - Time is virtual. The host calls dg_set_time() before each dg_tick(), so the
//     game advances exactly one tic per host step whatever the wall clock does.
//     That makes a run deterministic: the same key events at the same tic always
//     produce the same game, which is what lets another environment rebuild it.
//   - Keys arrive through dg_push_key() as Doom key codes (doomkeys.h).
//   - Frames are read straight out of linear memory: dg_screen() returns the
//     320x200 8-bit framebuffer and dg_palette() the 256-entry palette.

#include <stdint.h>
#include <string.h>

#include "doomgeneric.h"
#include "i_video.h"

#define EXPORT(name) __attribute__((export_name(name)))

extern boolean palette_changed;

static uint32_t g_now_ms = 1000; // never 0: i_timer.c treats basetime 0 as unset
static uint32_t g_frames = 0;

#define KEYQUEUE_SIZE 64
static uint16_t s_keys[KEYQUEUE_SIZE];
static unsigned s_write = 0;
static unsigned s_read = 0;

static uint8_t s_palette[256 * 3];

// WASI has no processes. i_system.c only calls system() to show an error dialog.
int system(const char *command)
{
    (void)command;
    return -1;
}

void DG_Init(void) {}

void DG_DrawFrame(void) { g_frames++; }

// TryRunTics() sleeps while it waits for the next tic. Advancing the virtual
// clock here keeps that loop finite without involving the wall clock.
void DG_SleepMs(uint32_t ms) { g_now_ms += ms; }

uint32_t DG_GetTicksMs(void) { return g_now_ms; }

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (s_read == s_write)
        return 0;
    uint16_t k = s_keys[s_read];
    s_read = (s_read + 1) % KEYQUEUE_SIZE;
    *pressed = k >> 8;
    *key = k & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

EXPORT("dg_start")
void dg_start(void)
{
    static char *argv[] = {"doom", "-iwad", "/wad/freedoom1.wad", 0};
    doomgeneric_Create(3, argv);
}

EXPORT("dg_tick")
void dg_tick(void) { doomgeneric_Tick(); }

EXPORT("dg_set_time")
void dg_set_time(uint32_t ms)
{
    if (ms > g_now_ms)
        g_now_ms = ms;
}

EXPORT("dg_push_key")
int dg_push_key(int pressed, int key)
{
    unsigned next = (s_write + 1) % KEYQUEUE_SIZE;
    if (next == s_read)
        return 0; // queue full, drop
    s_keys[s_write] = (uint16_t)(((pressed ? 1 : 0) << 8) | (key & 0xff));
    s_write = next;
    return 1;
}

EXPORT("dg_frames")
uint32_t dg_frames(void) { return g_frames; }

EXPORT("dg_screen")
uint8_t *dg_screen(void) { return (uint8_t *)DG_ScreenBuffer; }

EXPORT("dg_width")
int dg_width(void) { return DOOMGENERIC_RESX; }

EXPORT("dg_height")
int dg_height(void) { return DOOMGENERIC_RESY; }

// Returns 1 and refreshes the RGB palette buffer if the game changed its palette
// (damage flash, item pickup) since the last call.
EXPORT("dg_palette_changed")
int dg_palette_changed(void)
{
    if (!palette_changed)
        return 0;
    palette_changed = false;
    for (int i = 0; i < 256; i++)
    {
        s_palette[i * 3 + 0] = colors[i].r;
        s_palette[i * 3 + 1] = colors[i].g;
        s_palette[i * 3 + 2] = colors[i].b;
    }
    return 1;
}

EXPORT("dg_palette")
uint8_t *dg_palette(void) { return s_palette; }
