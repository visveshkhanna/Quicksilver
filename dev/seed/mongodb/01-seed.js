// Runs once, as the root user, against MONGO_INITDB_DATABASE.
db.accounts.insertMany([
  { email: 'user1@example.com', name: 'User 1', tags: ['vip'], settings: { theme: 'dark' } },
  { email: 'user2@example.com', name: null, tags: [] },
  { email: 'emoji@example.com', name: 'Ravi 🚀 Kumar', joined: new Date('2025-01-01') },
])
db.accounts.createIndex({ email: 1 }, { unique: true })
