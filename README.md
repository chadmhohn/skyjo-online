# Skyjo Online

Multiplayer online version of the popular card game Skyjo.

## Features
- Real-time multiplayer rooms (2-8 players)
- Single player mode vs AI
- Password protected access
- Built with React + Vite + TypeScript + Tailwind + Firebase

## Quick Start
1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and add your Firebase config
4. `npm run dev`

## Tech Stack
- React 18 + TypeScript
- Vite
- Tailwind CSS + daisyUI
- Firebase (Realtime Database / Firestore for game state)
- React Router for navigation

## Game Rules Summary
- 3x4 grid of cards per player (-2 to 12)
- Flip 2 cards initially
- Draw or take discard, replace a card in your grid
- Columns of 3 identical cards are removed (score 0)
- Round ends when one player has all cards face up
- Lowest score wins the round. First to 100+ loses.