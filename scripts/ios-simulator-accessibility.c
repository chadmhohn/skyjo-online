#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

// Simulator-only test helper. This is compiled by the UI evidence script and is
// never linked into, copied into, or shipped with the Skyjo application.
extern bool _AXSDifferentiateWithoutColorEnabled(void);
extern bool _AXSReduceMotionEnabled(void);
extern void _AXSSetDifferentiateWithoutColorEnabled(bool enabled);
extern void _AXSSetReduceMotionEnabled(bool enabled);

int main(int argc, char **argv) {
  if (argc != 1 && argc != 3) return 64;
  if (argc == 3) {
    _AXSSetReduceMotionEnabled(atoi(argv[1]) != 0);
    _AXSSetDifferentiateWithoutColorEnabled(atoi(argv[2]) != 0);
  }
  printf(
    "%d\t%d\n",
    _AXSReduceMotionEnabled() ? 1 : 0,
    _AXSDifferentiateWithoutColorEnabled() ? 1 : 0
  );
  return 0;
}
