import { useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'

function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 to-indigo-900 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-8xl font-bold text-white mb-4 tracking-wider">SKYJO</h1>
        <p className="text-xl text-blue-200 mb-12">Online Multiplayer Card Game</p>
        <div className="space-x-4">
          <a href="/lobby" className="btn btn-primary btn-lg">Play Now</a>
        </div>
      </div>
    </div>
  )
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/lobby" element={<div>Lobby coming soon...</div>} />
      </Routes>
    </Router>
  )
}

export default App