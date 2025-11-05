CREATE TABLE features (
  id INT AUTO_INCREMENT PRIMARY KEY,
  feature_name VARCHAR(100),
  feature_tag VARCHAR(100),
  type ENUM('frontend', 'backend')
);

CREATE TABLE features_capability (
  capability_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  features_json JSON,
  CONSTRAINT chk_valid_json CHECK (JSON_VALID(features_json))
);


CREATE TABLE role_capability (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role VARCHAR(50),
  team VARCHAR(50),
  company VARCHAR(100),
  capability_id INT,
  FOREIGN KEY (capability_id) REFERENCES features_capability(capability_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- Companies table used to store app/company specific settings and slug
CREATE TABLE companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

create table apps(
  id int auto_increment primary key,
  company_id int not null,
  name varchar(100) not null,
  slug varchar(100) not null unique,
  created_at timestamp default current_timestamp,
  settings json,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

create table users(
  id int auto_increment primary key,
  name varchar(100) not null,
  email varchar(100) not null unique,
  password varchar(255) not null,
  role_id int not null,
  team_id int not null,
  company_id int not null,
  FOREIGN KEY (role_id) REFERENCES roles(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
  FOREIGN KEY (team_id) REFERENCES teams(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
)

create table teams(
  id int auto_increment primary key,
  name varchar(100) not null,
  company_id int not null,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

create table roles(
  id int auto_increment primary key,
  name varchar(100) not null,
  company_id int not null,
  FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE audio_recordings ( 
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  recorded_by VARCHAR(255) NOT NULL,
  recorded_by_role VARCHAR(50) NOT NULL,
  audio_url TEXT,
  audio_data LONGTEXT,
  transcription TEXT,
  company_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  processed_audio LONGTEXT,
  idempotency_key VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audio_idempotency (idempotency_key)
);