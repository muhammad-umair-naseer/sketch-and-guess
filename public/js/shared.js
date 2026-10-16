/*
 * Constants shared by the server (require) and the browser (window.Shared).
 * One source of truth so the server can validate exactly what the client offers.
 */
(function (root) {
  const Shared = {
    // Fixed internal canvas resolution. CSS scales it; every client renders
    // the same pixels, which keeps flood fill deterministic across clients.
    CANVAS_W: 800,
    CANVAS_H: 600,

    PALETTE: [
      '#000000', '#ffffff', '#7a7a7a', '#c8c8c8',
      '#e53935', '#ff7043', '#ffb300', '#fdd835',
      '#7cb342', '#2e7d32', '#00bcd4', '#1e88e5',
      '#283593', '#8e24aa', '#f06292', '#ffccbc',
      '#8d6e63', '#4e342e', '#ff8a80', '#b2ff59'
    ],
    ERASER: '#ffffff',
    SIZES: [4, 10, 20, 40],

    AVATARS: [
      '🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯',
      '🐨', '🐷', '🐙', '🦄', '🐧', '🐢', '🦉', '🐝',
      '🐳', '🦖', '👽', '🤖', '🎃', '👻', '🍩', '🌵'
    ],
    AVATAR_COLORS: ['#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#a78bfa', '#ff9f1c', '#2ec4b6', '#f72585'],

    DRAW_TIMES: [60, 80, 100, 120],
    MIN_ROUNDS: 2,
    MAX_ROUNDS: 6,
    MIN_PLAYERS: 2,
    MAX_PLAYERS: 12,
    CATEGORIES: {
      tech: 'Tech',
      everyday: 'Everyday',
      food: 'Food',
      animals: 'Animals',
      roman_urdu: 'Roman Urdu'
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Shared;
  else root.Shared = Shared;
})(this);
