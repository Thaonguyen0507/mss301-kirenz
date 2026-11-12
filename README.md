<p align="center">
  <h1 align="center">🌐 Kirenz Platform</h1>
  <p align="center">
    A full-stack social media platform built with microservices architecture
    <br />
    <strong>Real-time Chat · Social Feed · Stories · Friend System</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Java-21-ED8B00?style=for-the-badge&logo=openjdk&logoColor=white" alt="Java 21" />
  <img src="https://img.shields.io/badge/Spring_Boot-3.5-6DB33F?style=for-the-badge&logo=spring-boot&logoColor=white" alt="Spring Boot" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/Apache_Kafka-231F20?style=for-the-badge&logo=apachekafka&logoColor=white" alt="Kafka" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License" />
</p>

---

## 📖 Overview

**Kirenz Platform** is a production-grade social media application designed and built using a **microservices architecture**. It delivers a full suite of social networking features including real-time messaging, social feed with reactions, stories, friend management, and user privacy controls — all powered by event-driven communication and a hybrid database strategy.

The platform demonstrates expertise in distributed systems design, real-time communication protocols, and modern full-stack development.

---

## 🏗️ System Architecture

```
                         ┌──────────────────┐
                         │   React Frontend │
                         │  (Vite + TS)     │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │   API Gateway    │
                         │ (Spring Cloud)   │
                         └────────┬─────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
    ┌─────────▼────────┐ ┌───────▼────────┐ ┌────────▼───────┐
    │ Identity Service │ │ Social Service │ │  Chat Service  │
    │  (Auth + Users)  │ │ (Posts + Feed) │ │  (Real-time)   │
    └─────────┬────────┘ └───────┬────────┘ └────────┬───────┘
              │                   │                   │
    ┌─────────▼────────┐ ┌───────▼────────┐ ┌────────▼───────┐
    │ User Service     │ │ Notification   │ │ Discovery      │
    │ (Profiles)       │ │  Service       │ │  Service       │
    └──────────────────┘ └────────────────┘ └────────────────┘
              │                   │                   │
    ┌─────────▼───────────────────▼───────────────────▼──────┐
    │              Infrastructure Layer                      │
    │  PostgreSQL  ·  MongoDB  ·  Redis  ·  Apache Kafka     │
    └────────────────────────────────────────────────────────┘
```

### Microservices

| Service | Responsibility | Tech Highlights |
|---------|---------------|-----------------|
| **API Gateway** | Request routing, JWT validation, load balancing | Spring Cloud Gateway, Netflix Eureka Client, OAuth2 Resource Server |
| **Discovery Service** | Service registry & health monitoring | Netflix Eureka Server, Spring Actuator |
| **Identity Service** | Authentication, registration, email verification, token management | Spring Security, JWT (JJWT), Redis session/blacklist, Kafka event publishing, Brevo email API, Cloudinary |
| **User Service** | User profiles, friend system, blocking, privacy settings | Spring Data JPA, PostgreSQL, Liquibase migrations, OpenFeign inter-service calls |
| **Social Service** | Posts, comments, reactions, hashtags, bookmarks, media uploads | Spring Data MongoDB, Cloudinary CDN, Kafka event streaming, OpenFeign |
| **Chat Service** | Real-time 1-on-1 and group messaging, presence tracking | WebSocket (STOMP), Kafka pub/sub, MongoDB, Redis presence cache, OpenFeign |
| **Notification Service** | Event-driven notification delivery | Kafka consumer, OpenFeign, PostgreSQL |

---

## ✨ Key Features

### 🔐 Authentication & Security
- **JWT-based authentication** with access & refresh token flow
- **Email verification** via OTP (Brevo transactional email API)
- **Redis-backed token blacklisting** for secure logout
- **WebSocket authentication** via STOMP header JWT validation
- **Per-service security** with Spring Security filters

### 📱 Social Feed
- **Create, edit, delete posts** with rich text content
- **Multi-media uploads** (images/videos) via Cloudinary CDN
- **Reaction system** (like, love, etc.) on posts and comments
- **Comment threads** on posts
- **Hashtag** extraction and content categorization
- **Bookmark/save** posts for later

### 💬 Real-time Chat
- **WebSocket (STOMP over SockJS)** for bi-directional real-time communication
- **1-on-1 direct messaging** with auto-create conversation
- **Group chat** with multi-participant support
- **Kafka-based message pipeline** (input queue → process → output queue → broadcast)
- **Dual subscription pattern**: full message data to active chat window, lightweight summary to conversation list
- **Message delivery status tracking** (Sent → Delivered → Read)
- **Media attachments** in messages with Cloudinary integration
- **Online/offline presence tracking** via Redis
- **One-to-one video calls** via LiveKit Cloud with incoming ringtone, accept/decline, camera/microphone controls, and synchronized hangup. See the [call setup and API guide](docs/livekit-calls.md) and [server environment example](.env.livekit.example).

### 📸 Stories
- **Ephemeral content** with time-based expiration
- **Story viewer** with view count tracking
- **Full-screen story viewing** experience

### 👥 Social Graph
- **Friend request system** (send, accept, reject, cancel)
- **Friends list** with mutual friends
- **User blocking** functionality
- **Privacy settings** for profile visibility control

### 👤 User Profiles
- **Editable profiles** with avatar, cover photo, bio, location, and website
- **Profile settings** management
- **View other users' profiles** with contextual friend status

---

## 🛠️ Tech Stack

### Backend
| Technology | Version | Purpose |
|-----------|---------|---------|
| **Java** | 21 | Primary language (LTS) |
| **Spring Boot** | 3.5 | Application framework |
| **Spring Cloud** | 2025.0.3 | Microservices infrastructure |
| **Spring Cloud Gateway** | — | API gateway & routing |
| **Netflix Eureka** | — | Service discovery & registration |
| **Spring Security** | — | Authentication & authorization |
| **Spring WebSocket** | — | Real-time messaging (STOMP) |
| **Spring Data JPA** | — | PostgreSQL ORM |
| **Spring Data MongoDB** | — | Document database access |
| **Spring Data Redis** | — | Caching & session management |
| **Spring Kafka** | — | Event-driven messaging |
| **OpenFeign** | — | Declarative inter-service HTTP client |
| **Liquibase** | 4.31 | Database schema migrations |
| **MapStruct** | 1.6 | DTO ↔ Entity mapping |
| **JJWT** | 0.12.6 | JWT token creation & validation |
| **Cloudinary** | 1.39 | Cloud media storage & CDN |
| **Lombok** | — | Boilerplate code reduction |
| **Maven** | — | Multi-module build system |

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| **React** | 19 | UI library |
| **TypeScript** | 5.8 | Type-safe JavaScript |
| **Vite** | 6.2 | Build tool & dev server |
| **Tailwind CSS** | 4.1 | Utility-first styling |
| **React Router** | 6.30 | Client-side routing |
| **TanStack Query** | 5 | Server state management & caching |
| **Zustand** | 5 | Client state management |
| **Axios** | 1.18 | HTTP client |
| **STOMP.js** | 7.3 | WebSocket STOMP protocol client |
| **SockJS** | 1.6 | WebSocket fallback transport |
| **Framer Motion** | 12 | Animations & transitions |
| **Lucide React** | — | Icon library |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| **PostgreSQL** | Relational data (users, profiles, friendships) |
| **MongoDB** | Document data (posts, comments, messages, conversations) |
| **Redis** | Token blacklisting, caching, presence tracking |
| **Apache Kafka** | Async event streaming between services |
| **Docker Compose** | Local infrastructure orchestration |

---

## 🗄️ Database Design

The platform uses a **hybrid database architecture** optimized for each data access pattern:

### PostgreSQL (Relational Data)
- **`users`** — Core authentication data, email, password hash, premium status
- **`profiles`** — User profile information (avatar, bio, location, website)
- **`friendships`** — Friend relationships and request status
- **`blocked_users`** — User blocking records
- **`privacy_settings`** — Per-user privacy configuration

### MongoDB (Document Data)
- **`posts`** — User posts with media attachments, slug-based URL routing
- **`comments`** — Threaded comments on posts
- **`reactions`** — Like/reaction records on posts and comments
- **`conversations`** — Chat conversations (direct & group) with denormalized last message
- **`messages`** — Chat messages with attachments and per-recipient delivery status
- **`hashtags`** — Content categorization tags
- **`bookmarks`** — Saved/bookmarked posts

### Cross-Database Reference Pattern
```
PostgreSQL users.id  ←——→  MongoDB documents.userId
```
User identity lives in PostgreSQL; high-volume content references users by ID in MongoDB.

---

## 📂 Project Structure

```
kirenz-platform/
├── api-gateway/              # Spring Cloud Gateway — request routing & JWT validation
├── discovery-service/        # Netflix Eureka Server — service registry
├── identity-service/         # Auth, registration, email verification, token management
├── user-service/             # Profiles, friends, blocking, privacy
├── social-service/           # Posts, comments, reactions, hashtags, bookmarks, media
├── chat-service/             # WebSocket chat, Kafka messaging, presence tracking
├── notification-service/     # Event-driven notification delivery
├── frontend/                 # React 19 + TypeScript + Vite SPA
│   └── src/
│       ├── components/       # Reusable UI components (Layout, Post, OTP, etc.)
│       ├── hooks/            # Custom React hooks (useAuth, useChat, useBlocks)
│       ├── services/         # API service layer (auth, chat, post, websocket, etc.)
│       ├── store/            # Zustand state management
│       ├── types/            # TypeScript type definitions
│       └── utils/            # Utility functions (theme, helpers)
├── docker-compose.yml        # Local infrastructure (Redis, Kafka)
└── pom.xml                   # Maven multi-module parent POM
```

---

## 🚀 Getting Started

### Prerequisites

- **Java 21** (JDK)
- **Node.js 18+** & npm
- **Docker & Docker Compose**
- **PostgreSQL** instance (local or cloud)
- **MongoDB** instance (local or cloud)

### 1. Start Infrastructure Services

```bash
docker-compose up -d
```

This spins up **Redis** and **Apache Kafka** locally.

### 2. Configure Environment Variables

Each service has a `.env` file. Copy `.env.example` (where available) and fill in:

```env
# Database
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=your_password
IDENTITY_DATABASE_URL=jdbc:postgresql://localhost:5432/identity_db
USER_DATABASE_URL=jdbc:postgresql://localhost:5432/user_db

# JWT
JWT_SECRET=your_jwt_secret_key

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Email (Brevo)
BREVO_API_KEY=your_brevo_api_key
```

### 3. Build & Run Backend Services

```bash
# From project root — build all modules
mvn clean install -DskipTests

# Start services in order:
# 1. Discovery Service (Eureka)
cd discovery-service && mvn spring-boot:run

# 2. Identity Service
cd identity-service && mvn spring-boot:run

# 3. User Service
cd user-service && mvn spring-boot:run

# 4. Social Service
cd social-service && mvn spring-boot:run

# 5. Chat Service
cd chat-service && mvn spring-boot:run

# 6. Notification Service
cd notification-service && mvn spring-boot:run

# 7. API Gateway
cd api-gateway && mvn spring-boot:run
```

### 4. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

The app will be available at `http://localhost:3000`.

---

## 🔑 Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Hybrid DB (PostgreSQL + MongoDB)** | PostgreSQL for relational integrity (users, friendships); MongoDB for high-volume, schema-flexible content (posts, messages) |
| **Kafka for async events** | Decouples services for user registration events, notifications, and chat message processing |
| **Redis for presence & tokens** | Sub-millisecond reads for online status and token blacklist lookups |
| **STOMP over SockJS** | Standardized WebSocket messaging with automatic fallback for browser compatibility |
| **Dual Subscription Pattern** | Optimizes bandwidth — full message payload to active chat, lightweight summary to conversation list sidebar |
| **Eureka Service Discovery** | Dynamic service registration enables horizontal scaling without hard-coded endpoints |
| **Liquibase Migrations** | Version-controlled, reproducible database schema evolution |
| **MapStruct for DTO mapping** | Compile-time code generation for type-safe, zero-reflection object mapping |

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](./LICENSE) file for details.

---

## 👨‍💻 Author

**Vu Huu Nguyen Khoi**  
**Tran Ho Thao Nguyen ❤️**

---

<p align="center">
  Built with ❤️ using Java, Spring Boot, React, and modern cloud-native technologies.
</p>
