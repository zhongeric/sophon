# The scan box: one search unit, with no network. It holds no secrets and no holdout data.
# The image holds the research packages and a warm numba cache, so that a unit needs no install and no download.
FROM --platform=linux/amd64 python:3.11-slim-bookworm

# Scan box commands get the same NUMBA_CACHE_DIR and NUMBA_CPU_NAME (src/cloudflare/scan-slot.ts). The cache key holds
# the CPU name, so the generic CPU lets a host with a different CPU use the cache of the build.
ENV NUMBA_CACHE_DIR=/opt/numba-cache NUMBA_CPU_NAME=generic

# gcc builds batman-package (a transitleastsquares dependency) when pip finds no wheel. The image does not keep it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && pip install --no-cache-dir \
    numpy==1.26.4 \
    scipy==1.13.1 \
    astropy==6.1.7 \
    lightkurve==2.5.0 \
    wotan==1.10 \
    transitleastsquares==1.32 \
    numba==0.60.0 \
  && apt-get purge -y --auto-remove gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

# Astropy uses its bundled IERS data and does not try a download. Commands run with HOME=/root (boxEnv).
RUN mkdir -p /root/.astropy/config \
  && printf '[utils.iers.iers]\nauto_download = False\n' > /root/.astropy/config/astropy.cfg

# Compile the numba functions of wotan and transitleastsquares into the cache, on a small synthetic light curve.
RUN python <<'EOF'
import numpy as np
from transitleastsquares import transitleastsquares
from wotan import flatten

t = np.linspace(0, 10, 2000)
y = 1 + 1e-4 * np.random.default_rng(0).standard_normal(t.size)
y[(t % 2.5) < 0.1] -= 1e-3
flat = flatten(t, y, method='biweight', window_length=0.5)
transitleastsquares(t, flat).power(period_min=1, period_max=4, oversampling_factor=1, duration_grid_step=1.5, use_threads=1, show_progress_bar=False)
EOF

WORKDIR /
CMD ["sleep", "infinity"]
