(function () {
  const profile = Object.freeze({
    cameraThetaDeg: 32,
    cameraPhiDeg: 74,
    cameraRadiusPercent: 108,
    cameraTarget: '0m 0m 0m',
    fieldOfView: '27deg',
    rotationPerSecond: '42deg',
    exposure: '1',
    shadowIntensity: '0',
    touchAction: 'pan-y',
    interactionPrompt: 'none',
    reveal: 'auto',
    background: '#000000',
  });

  function getCameraOrbit(thetaDeg = profile.cameraThetaDeg) {
    return `${thetaDeg}deg ${profile.cameraPhiDeg}deg ${profile.cameraRadiusPercent}%`;
  }

  function applyModelViewerProfile(viewer, overrides = {}) {
    if (!viewer) return null;

    const merged = {
      ...profile,
      ...overrides,
    };

    viewer.cameraTarget = merged.cameraTarget;
    viewer.cameraOrbit = getCameraOrbit(merged.cameraThetaDeg);
    viewer.fieldOfView = merged.fieldOfView;
    viewer.autoRotate = merged.autoRotate !== false;
    viewer.autoRotateDelay = Number.isFinite(Number(merged.autoRotateDelay))
      ? Number(merged.autoRotateDelay)
      : 0;

    viewer.setAttribute('interaction-prompt', merged.interactionPrompt);
    viewer.setAttribute('reveal', merged.reveal);
    viewer.setAttribute('rotation-per-second', merged.rotationPerSecond);
    viewer.setAttribute('touch-action', merged.touchAction);
    viewer.setAttribute('shadow-intensity', merged.shadowIntensity);
    viewer.setAttribute('exposure', merged.exposure);

    if (viewer.style) {
      viewer.style.background = merged.background;
    }

    return merged;
  }

  window.NoPunksWorld3dRenderProfile = profile;
  window.getNoPunksWorld3dCameraOrbit = getCameraOrbit;
  window.applyNoPunksWorld3dRenderProfile = applyModelViewerProfile;
})();
