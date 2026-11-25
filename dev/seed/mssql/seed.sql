IF DB_ID('quicksilver_dev') IS NULL CREATE DATABASE quicksilver_dev;
GO
USE quicksilver_dev;
GO
IF OBJECT_ID('dbo.accounts') IS NULL
BEGIN
    CREATE TABLE dbo.accounts (
        id          BIGINT IDENTITY PRIMARY KEY,
        email       NVARCHAR(255) NOT NULL UNIQUE,
        name        NVARCHAR(255) NULL,
        created_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    INSERT INTO dbo.accounts (email, name) VALUES
        (N'user1@example.com', N'User 1'),
        (N'emoji@example.com', N'Ravi 🚀 Kumar'),
        (N'naive@example.com', NULL);
END
GO
